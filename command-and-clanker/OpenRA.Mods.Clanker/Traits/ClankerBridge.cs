using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using OpenRA.Graphics;
using OpenRA.Mods.Clanker.Protocol;
using OpenRA.Mods.Common.Activities;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Clanker.Traits
{
	[TraitLocation(SystemActors.World)]
	[Desc("Connects to the Command & Clanker backend over WebSocket and renders",
		"its live world (terminal islands, folder regions, and the files agents",
		"touch) as actors and resources on the map.")]
	public class ClankerBridgeInfo : TraitInfo
	{
		[Desc("Backend WebSocket endpoint for the live world stream.")]
		public readonly string LiveUrl = "ws://127.0.0.1:3001/live";

		[Desc("Backend HTTP base URL for outbound commands (build terminal, agent controls).")]
		public readonly string HttpUrl = "http://127.0.0.1:3001";

		[ActorReference]
		[Desc("Actor spawned for each terminal island.")]
		public readonly string TerminalActor = "clanker.terminal";

		[Desc("Wall actors placed around folder perimeters, chosen by nesting depth",
			"(level 0 = outermost). The last entry covers any deeper level.")]
		public readonly string[] WallActorsByLevel = { "brik", "sbag", "barb" };

		[ActorReference]
		[Desc("Wall actor for a folder's top-left corner; it carries the folder name label.")]
		public readonly string FolderLabelWall = "clanker.folderwall";

		[Desc("Resource type placed inside a folder for each file an agent touches.")]
		public readonly string ResourceType = "Ore";

		[Desc("Resource density added per touched file.")]
		public readonly byte ResourceDensity = 5;

		[ActorReference]
		[Desc("Unit spawned for each agent (Claude / default), homed on its terminal island.")]
		public readonly string AgentActor = "clanker.agent";

		[ActorReference]
		[Desc("Unit for opencode agents.")]
		public readonly string OpencodeAgentActor = "clanker.agent.opencode";

		[ActorReference]
		[Desc("Unit for codex agents.")]
		public readonly string CodexAgentActor = "clanker.agent.codex";

		[ActorReference]
		[Desc("Unit for hermes agents.")]
		public readonly string HermesAgentActor = "clanker.agent.hermes";

		[ActorReference]
		[Desc("Unit spawned for each subagent.")]
		public readonly string SubagentActor = "clanker.subagent";

		[Desc("Internal name of the player that owns the spawned world. It must",
			"not be allied to the commander, so islands stay hidden under fog",
			"until they are scouted.")]
		public readonly string OwnerPlayer = "Neutral";

		public override object Create(ActorInitializer init) { return new ClankerBridge(this); }
	}

	// The background thread only ever touches the ConcurrentQueue; every World,
	// Actor, Map, and resource access happens on the game thread inside ITick and
	// the AddFrameEndTask it schedules. That boundary is what keeps the bridge safe.
	public class ClankerBridge : IWorldLoaded, ITick, INotifyActorDisposing, IRenderAnnotations
	{
		readonly ClankerBridgeInfo info;
		readonly ConcurrentQueue<LiveMessage> inbox = new();
		readonly Dictionary<string, Actor> islands = new();
		readonly Dictionary<string, ClankerTerminalRef> islandRefs = new();
		readonly Dictionary<string, List<Actor>> folderWalls = new();
		readonly Dictionary<string, Region> folderRegions = new();
		readonly Dictionary<string, Dictionary<string, CPos>> placedFiles = new();
		readonly Dictionary<string, Actor> agents = new();
		readonly Dictionary<string, CPos> agentHome = new();
		readonly Dictionary<string, CPos> agentTarget = new();
		readonly Dictionary<string, ClankerLabel> agentLabels = new();
		readonly Dictionary<string, string> activeLinks = new();
		IReadOnlyList<(WPos Start, WPos End, Color Color)> connectors = new List<(WPos, WPos, Color)>();

		// Stable indented-tree layout for folders: each folder keeps a recycled row,
		// and its x-indent comes from its depth in the touched-folder forest, so the
		// set reads as a hierarchy and does not reshuffle as folders come and go.
		const int FolderW = 6;
		const int FolderH = 5;
		const int IndentX = 8;
		const int RowStride = 7;
		readonly Dictionary<string, CPos> folderOrigins = new();
		readonly Dictionary<string, int> folderRows = new();
		readonly List<int> freeFolderRows = new();
		int nextFolderRow;
		CPos layoutBase;

		CancellationTokenSource termCts;
		string streamedId;
		volatile ClankerTermGrid termGrid;
		readonly ConcurrentQueue<string> termSend = new();

		// The selected terminal's resolved screen, repainted by the terminal widget.
		public ClankerTermGrid TerminalGrid => termGrid;

		// The id of the terminal currently mirrored, or null when none is selected.
		public string StreamedTerminal => streamedId;

		World world;
		Player owner;
		IResourceLayer resources;
		MapCoords coords;
		CancellationTokenSource cts;

		public ClankerBridge(ClankerBridgeInfo info)
		{
			this.info = info;
		}

		void IWorldLoaded.WorldLoaded(World w, WorldRenderer wr)
		{
			world = w;
			owner = FindOwner(w);
			resources = w.WorldActor.TraitOrDefault<IResourceLayer>();
			ClankerBackend.BaseUrl = info.HttpUrl;

			var bounds = w.Map.Bounds;
			coords = new MapCoords(bounds.Left + (bounds.Width / 2), bounds.Top + (bounds.Height / 2));
			// Anchor the folder tree just left of the terminal cluster at map center
			// so agents (which spawn next to their terminal) can path to it instead
			// of trekking across the whole map to a far corner.
			layoutBase = new CPos(
				bounds.Left + (bounds.Width / 2) - 44,
				bounds.Top + (bounds.Height / 2) - 8);

			cts = new CancellationTokenSource();
			Task.Run(() => RunSocketLoop(cts.Token));
		}

		Player FindOwner(World w)
		{
			foreach (var p in w.Players)
				if (p.InternalName == info.OwnerPlayer)
					return p;

			return w.WorldActor.Owner;
		}

		string AgentActorForTool(string tool, bool isSubagent)
		{
			if (isSubagent)
				return info.SubagentActor;

			return tool switch
			{
				"opencode" => info.OpencodeAgentActor,
				"codex" => info.CodexAgentActor,
				"hermes" => info.HermesAgentActor,
				_ => info.AgentActor,
			};
		}

		// Adopt a player-built Terminal as the island for a backend terminal id, so
		// ApplyRegions does not also spawn a duplicate island for it.
		public void RegisterPlayerTerminal(string id, Actor actor)
		{
			if (string.IsNullOrEmpty(id) || islands.ContainsKey(id))
				return;

			islands[id] = actor;
			islandRefs[id] = actor.TraitOrDefault<ClankerTerminalRef>();
		}

		async Task RunSocketLoop(CancellationToken ct)
		{
			var uri = new Uri(info.LiveUrl);
			var buffer = new byte[1 << 16];
			while (!ct.IsCancellationRequested)
			{
				try
				{
					using var socket = new ClientWebSocket();
					await socket.ConnectAsync(uri, ct);

					var sb = new StringBuilder();
					while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
					{
						var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
						if (result.MessageType == WebSocketMessageType.Close)
							break;

						sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
						if (!result.EndOfMessage)
							continue;

						var msg = LiveMessage.Parse(sb.ToString());
						sb.Clear();
						if (msg != null)
							inbox.Enqueue(msg);
					}
				}
				catch (OperationCanceledException)
				{
					return;
				}
				catch (Exception)
				{
					// Backend down or connection dropped: fall through, back off, reconnect.
				}

				try
				{
					await Task.Delay(1000, ct);
				}
				catch (OperationCanceledException)
				{
					return;
				}
			}
		}

		void ITick.Tick(Actor self)
		{
			while (inbox.TryDequeue(out var msg))
			{
				if (msg.Kind == "world-delta" && msg.Regions != null)
				{
					var regions = msg.Regions;
					world.AddFrameEndTask(w => ApplyRegions(w, regions));
				}
				else if (msg.Kind == "files" && msg.Files != null)
				{
					var files = msg.Files;
					world.AddFrameEndTask(w => ApplyFiles(w, files));
				}
				else if (msg.Kind == "agents" && msg.Agents != null)
				{
					var snapshots = msg.Agents;
					world.AddFrameEndTask(w => ApplyAgents(w, snapshots));
				}
			}
		}

		void ApplyRegions(World w, List<Region> regions)
		{
			var liveTerminals = new HashSet<string>();
			var liveFolders = new HashSet<string>();

			foreach (var region in regions)
			{
				if (region.IsTerminal)
				{
					liveTerminals.Add(region.Path);
					if (!islands.ContainsKey(region.Path))
					{
						var (x, y) = coords.RegionOrigin(region);
						var cell = new CPos(x, y);
						if (w.Map.Contains(cell))
						{
							var island = w.CreateActor(info.TerminalActor,
							[
								new LocationInit(cell),
								new OwnerInit(owner),
								new ClankerTerminalRefInit(region.Path),
							]);
							islands[region.Path] = island;
							islandRefs[region.Path] = island.TraitOrDefault<ClankerTerminalRef>();
						}
					}
				}
				else
				{
					liveFolders.Add(region.Path);
					if (!folderWalls.ContainsKey(region.Path))
					{
						var row = freeFolderRows.Count > 0 ? PopFreeRow() : nextFolderRow++;
						var depth = FolderDepth(region.Path, regions);
						var origin = layoutBase + new CVec(depth * IndentX, row * RowStride);
						folderRows[region.Path] = row;
						folderOrigins[region.Path] = origin;
						folderRegions[region.Path] = region;
						folderWalls[region.Path] = BuildFolderWalls(w, origin, region.Level, Basename(region.Path));
					}
				}
			}

			RemoveMissingIslands(liveTerminals);
			RemoveMissingFolders(liveFolders);
			RebuildConnectors(w);
		}

		// Outlines a folder with wall actors along the perimeter of its fixed box so
		// it reads as a fenced-off compound at its tree position.
		List<Actor> BuildFolderWalls(World w, CPos origin, int level, string name)
		{
			var walls = new List<Actor>();
			var wall = info.WallActorsByLevel[Math.Min(level, info.WallActorsByLevel.Length - 1)];

			for (var dy = 0; dy < FolderH; dy++)
			{
				for (var dx = 0; dx < FolderW; dx++)
				{
					if (dx != 0 && dy != 0 && dx != FolderW - 1 && dy != FolderH - 1)
						continue;

					var cell = origin + new CVec(dx, dy);
					if (!w.Map.Contains(cell))
						continue;

					// The top-left corner wall carries the folder's name as a label;
					// the rest use the depth-styled wall.
					var isLabelCorner = dx == 0 && dy == 0;
					var actor = w.CreateActor(isLabelCorner ? info.FolderLabelWall : wall,
					[
						new LocationInit(cell),
						new OwnerInit(owner),
					]);

					if (isLabelCorner)
					{
						var label = actor.TraitOrDefault<ClankerLabel>();
						if (label != null)
							label.Label = name;
					}

					walls.Add(actor);
				}
			}

			return walls;
		}

		static string Basename(string path)
		{
			if (string.IsNullOrEmpty(path))
				return "";

			var trimmed = path.TrimEnd('/');
			var slash = trimmed.LastIndexOf('/');
			return slash >= 0 ? trimmed[(slash + 1)..] : trimmed;
		}

		static string DescribeActivity(FileActivity activity)
		{
			if (activity == null)
				return "idle";

			var target = Basename(string.IsNullOrEmpty(activity.Path) ? activity.Dir : activity.Path);
			return activity.Direction switch
			{
				"read" => $"reading {target}",
				"write" => $"writing {target}",
				"run" => $"running in {Basename(activity.Dir)}",
				_ => activity.Direction,
			};
		}

		// Places one ore deposit per touched file inside the folder's file strip,
		// at a stable hashed cell, and removes deposits for files that are gone.
		void ApplyFiles(World w, List<FolderFiles> files)
		{
			if (resources == null)
				return;

			foreach (var folder in files)
			{
				if (folder.Entries == null || !folderOrigins.TryGetValue(folder.Dir, out var origin))
					continue;

				var cells = FolderFileCells(w, origin);
				if (cells.Count == 0)
					continue;

				if (!placedFiles.TryGetValue(folder.Dir, out var placed))
				{
					placed = new Dictionary<string, CPos>();
					placedFiles[folder.Dir] = placed;
				}

				var current = new HashSet<string>();
				foreach (var entry in folder.Entries)
				{
					current.Add(entry.Path);
					if (placed.ContainsKey(entry.Path))
						continue;

					// Place directly rather than via CanAddResource: that gate enforces
					// RA's harvester terrain rules (Clear/Road only), but here ore is
					// just a marker for a touched file and should show on any ground.
					var cell = cells[SlotFor(entry.Path, cells.Count)];
					resources.AddResource(info.ResourceType, cell, info.ResourceDensity);
					placed[entry.Path] = cell;
				}

				var gone = new List<string>();
				foreach (var path in placed.Keys)
					if (!current.Contains(path))
						gone.Add(path);

				foreach (var path in gone)
				{
					resources.RemoveResource(info.ResourceType, placed[path], info.ResourceDensity);
					placed.Remove(path);
				}
			}
		}

		// The interior cells of a folder box, where file ore is stacked.
		List<CPos> FolderFileCells(World w, CPos origin)
		{
			var list = new List<CPos>();
			for (var dy = 1; dy < FolderH - 1; dy++)
				for (var dx = 1; dx < FolderW - 1; dx++)
				{
					var cell = origin + new CVec(dx, dy);
					if (w.Map.Contains(cell))
						list.Add(cell);
				}

			return list;
		}

		static int SlotFor(string path, int count)
		{
			var hash = 0;
			foreach (var ch in path)
				hash = ((hash * 31) + ch) & 0x7fffffff;

			return hash % count;
		}

		// Spawns a unit per agent on its terminal island and drives it to the
		// folder it is currently working in, sending it home when it goes idle.
		void ApplyAgents(World w, List<AgentSnapshot> snapshots)
		{
			var live = new HashSet<string>();
			activeLinks.Clear();
			foreach (var snap in snapshots)
			{
				if (snap.Id == null)
					continue;

				live.Add(snap.Id);

				if (!snap.IsSubagent && snap.Terminal != null)
				{
					if (islandRefs.TryGetValue(snap.Terminal, out var termRef) && termRef != null)
					{
						termRef.Recent = snap.Recent ?? new List<string>();
						termRef.Activity = DescribeActivity(snap.Activity);
					}

					if (snap.Activity != null && folderRegions.ContainsKey(snap.Activity.Dir))
						activeLinks[snap.Terminal] = snap.Activity.Dir;
				}

				if (!agents.TryGetValue(snap.Id, out var unit))
				{
					if (snap.Terminal == null || !islands.TryGetValue(snap.Terminal, out var island))
						continue;

					var home = island.Location + new CVec(3, 0);
					if (!w.Map.Contains(home))
						home = island.Location;

					var actorName = AgentActorForTool(snap.Tool, snap.IsSubagent);
					unit = w.CreateActor(actorName,
					[
						new LocationInit(home),
						new OwnerInit(owner),
					]);

					agents[snap.Id] = unit;
					agentHome[snap.Id] = home;
					agentTarget[snap.Id] = home;
					agentLabels[snap.Id] = unit.TraitOrDefault<ClankerLabel>();
				}

				if (!unit.IsInWorld)
					continue;

				var target = agentHome[snap.Id];
				if (snap.Activity != null && folderOrigins.TryGetValue(snap.Activity.Dir, out var folderOrigin))
				{
					// Park just outside the folder's west wall: the interior is sealed by
					// the perimeter walls, so the unit approaches the folder rather than
					// trying to path into a blocked cell.
					var folderTarget = folderOrigin + new CVec(-1, FolderH / 2);
					if (w.Map.Contains(folderTarget))
						target = folderTarget;
				}

				if (agentTarget[snap.Id] != target)
				{
					unit.QueueActivity(false, new Move(unit, target));
					agentTarget[snap.Id] = target;
				}

				if (agentLabels.TryGetValue(snap.Id, out var label) && label != null)
					label.Label = snap.Activity != null ? snap.Activity.Direction.ToUpperInvariant() : "";
			}

			RemoveMissingAgents(live);
			RebuildConnectors(w);
		}

		void RemoveMissingAgents(HashSet<string> live)
		{
			var gone = new List<string>();
			foreach (var id in agents.Keys)
				if (!live.Contains(id))
					gone.Add(id);

			foreach (var id in gone)
			{
				if (agents.TryGetValue(id, out var unit) && unit.IsInWorld)
					unit.Dispose();

				agents.Remove(id);
				agentHome.Remove(id);
				agentTarget.Remove(id);
				agentLabels.Remove(id);
			}
		}

		void RemoveMissingIslands(HashSet<string> live)
		{
			var gone = new List<string>();
			foreach (var path in islands.Keys)
				if (!live.Contains(path))
					gone.Add(path);

			foreach (var path in gone)
			{
				if (islands.TryGetValue(path, out var actor) && actor.IsInWorld)
					actor.Dispose();

				islands.Remove(path);
				islandRefs.Remove(path);
			}
		}

		void RemoveMissingFolders(HashSet<string> live)
		{
			var gone = new List<string>();
			foreach (var path in folderWalls.Keys)
				if (!live.Contains(path))
					gone.Add(path);

			foreach (var path in gone)
			{
				if (folderWalls.TryGetValue(path, out var walls))
					foreach (var wall in walls)
						if (wall.IsInWorld)
							wall.Dispose();

				if (placedFiles.TryGetValue(path, out var placed))
				{
					if (resources != null)
						foreach (var cell in placed.Values)
							resources.ClearResources(cell);

					placedFiles.Remove(path);
				}

				if (folderRows.TryGetValue(path, out var freedRow))
				{
					freeFolderRows.Add(freedRow);
					folderRows.Remove(path);
				}

				folderWalls.Remove(path);
				folderRegions.Remove(path);
				folderOrigins.Remove(path);
			}
		}

		void RebuildConnectors(World w)
		{
			var list = new List<(WPos, WPos, Color)>();

			// Parent -> child folder edges (the directory tree).
			foreach (var path in folderOrigins.Keys)
			{
				var parent = ParentOf(path);
				if (parent != null && folderOrigins.ContainsKey(parent))
					list.Add((FolderCenter(w, parent), FolderCenter(w, path), Color.Gray));
			}

			// Terminal -> the folder its agent is working in right now.
			foreach (var kv in activeLinks)
			{
				if (islands.TryGetValue(kv.Key, out var island) && island.IsInWorld
					&& folderOrigins.ContainsKey(kv.Value))
					list.Add((island.CenterPosition, FolderCenter(w, kv.Value), Color.Cyan));
			}

			connectors = list;
		}

		string ParentOf(string path)
		{
			string best = null;
			foreach (var other in folderOrigins.Keys)
			{
				if (other == path || !path.StartsWith(other + "/", StringComparison.Ordinal))
					continue;

				if (best == null || other.Length > best.Length)
					best = other;
			}

			return best;
		}

		WPos FolderCenter(World w, string path)
		{
			if (!folderOrigins.TryGetValue(path, out var origin))
				return WPos.Zero;

			return w.Map.CenterOfCell(origin + new CVec(FolderW / 2, FolderH / 2));
		}

		// How many of the touched folders are ancestors of this path; drives the
		// horizontal indent so deeper folders sit further right.
		static int FolderDepth(string path, List<Region> regions)
		{
			var depth = 0;
			foreach (var r in regions)
				if (!r.IsTerminal && r.Path != path
					&& path.StartsWith(r.Path + "/", StringComparison.Ordinal))
					depth++;

			return depth;
		}

		int PopFreeRow()
		{
			var row = freeFolderRows[^1];
			freeFolderRows.RemoveAt(freeFolderRows.Count - 1);
			return row;
		}

		IEnumerable<IRenderable> IRenderAnnotations.RenderAnnotations(Actor self, WorldRenderer wr)
		{
			foreach (var c in connectors)
				yield return new LineAnnotationRenderable(c.Start, c.End, 1, c.Color);
		}

		bool IRenderAnnotations.SpatiallyPartitionable => false;

		// Point the grid view at a terminal (or null to stop). Driven by the
		// sidebar as the selection changes; the screen is exposed via TerminalGrid.
		public void SetStreamedTerminal(string id)
		{
			if (id == streamedId)
				return;

			streamedId = id;
			termCts?.Cancel();
			termGrid = null;
			termSend.Clear();

			if (string.IsNullOrEmpty(id))
				return;

			termCts = new CancellationTokenSource();
			var token = termCts.Token;
			var url = info.HttpUrl.Replace("http", "ws") + "/termview?id=" + id;
			Task.Run(() => RunTermStream(url, token));
		}

		// Queue raw keystrokes for the selected terminal's PTY (e.g. "\r", "\x03").
		public void SendTerminalInput(string data)
		{
			if (!string.IsNullOrEmpty(streamedId) && !string.IsNullOrEmpty(data))
				termSend.Enqueue(JsonSerializer.Serialize(new { i = data }));
		}

		// Ask the backend to resize the PTY so it matches the on-screen grid.
		public void SendTerminalResize(int cols, int rows)
		{
			if (!string.IsNullOrEmpty(streamedId) && cols > 0 && rows > 0)
				termSend.Enqueue(JsonSerializer.Serialize(new { r = new[] { cols, rows } }));
		}

		async Task RunTermStream(string url, CancellationToken ct)
		{
			try
			{
				using var socket = new ClientWebSocket();
				await socket.ConnectAsync(new Uri(url), ct);

				// One task receives grid frames; the other drains queued keystrokes.
				// A ClientWebSocket permits one concurrent send and one receive.
				var send = PumpInput(socket, ct);
				await ReceiveGrids(socket, ct);
				await send;
			}
			catch (OperationCanceledException)
			{
			}
			catch (Exception)
			{
			}
		}

		async Task ReceiveGrids(ClientWebSocket socket, CancellationToken ct)
		{
			var buffer = new byte[1 << 16];
			var msg = new StringBuilder();
			while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
			{
				var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
				if (result.MessageType == WebSocketMessageType.Close)
					break;

				msg.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
				if (!result.EndOfMessage)
					continue;

				ParseGrid(msg.ToString());
				msg.Clear();
			}
		}

		async Task PumpInput(ClientWebSocket socket, CancellationToken ct)
		{
			while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
			{
				if (termSend.TryDequeue(out var payload))
				{
					var bytes = Encoding.UTF8.GetBytes(payload);
					await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
				}
				else
					await Task.Delay(12, ct);
			}
		}

		void ParseGrid(string json)
		{
			try
			{
				using var doc = JsonDocument.Parse(json);
				var root = doc.RootElement;
				if (!root.TryGetProperty("kind", out var kind) || kind.GetString() != "term-grid")
					return;

				var linesEl = root.GetProperty("lines");
				var lines = new string[linesEl.GetArrayLength()];
				var i = 0;
				foreach (var l in linesEl.EnumerateArray())
					lines[i++] = l.GetString() ?? "";

				termGrid = new ClankerTermGrid
				{
					Cols = root.GetProperty("cols").GetInt32(),
					Rows = root.GetProperty("rows").GetInt32(),
					CursorX = root.GetProperty("cursorX").GetInt32(),
					CursorY = root.GetProperty("cursorY").GetInt32(),
					Lines = lines,
				};
			}
			catch (Exception)
			{
			}
		}


		void INotifyActorDisposing.Disposing(Actor self)
		{
			cts?.Cancel();
			termCts?.Cancel();
		}
	}
}
