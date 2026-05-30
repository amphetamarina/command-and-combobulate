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
using OpenRA.Mods.Common.Effects;
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

		[ActorReference]
		[Desc("Civilian building actors placed inside a folder, one per file an agent",
			"touches; the variant is chosen by file extension so similar files match.")]
		public readonly string[] FileActors =
		{
			"clanker.file1", "clanker.file2", "clanker.file3",
			"clanker.file4", "clanker.file5", "clanker.file6", "clanker.file7",
		};

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
		readonly Dictionary<string, Dictionary<string, Actor>> placedFiles = new();
		readonly Dictionary<string, Actor> agents = new();
		readonly Dictionary<string, CPos> agentHome = new();
		readonly Dictionary<string, CPos> agentTarget = new();
		readonly Dictionary<string, ClankerLabel> agentLabels = new();
		// Last (verb|path|ok) seen per agent, so a completed action fires its
		// success/failure effect exactly once instead of on every snapshot tick.
		readonly Dictionary<string, string> agentActivitySig = new();
		readonly Dictionary<string, string> activeLinks = new();
		IReadOnlyList<(WPos Start, WPos End, Color Color)> connectors = new List<(WPos, WPos, Color)>();

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
			ClankerBackend.BaseUrl = info.HttpUrl;

			var bounds = w.Map.Bounds;
			// Anchor the agent world just south-east of the commander's base (top-left)
			// so terminals and folders appear near it rather than across the map.
			coords = new MapCoords(bounds.Left + 31, bounds.Top + 25);

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
						folderRegions[region.Path] = region;
						folderWalls[region.Path] = BuildFolderWalls(w, region);
					}
				}
			}

			RemoveMissingIslands(liveTerminals);
			RemoveMissingFolders(liveFolders);
			RebuildConnectors(w);
		}

		// The perimeter wall that styles a folder's compound by what the directory
		// is for: concrete for a source base, barbed wire for dependency sprawl, a
		// fence for docs/CI, sandbags for tests. Unclassified folders fall back to
		// the depth-tiered wall so nesting still reads.
		string WallActorForRole(string role, int level)
		{
			switch (role)
			{
				case "source": return "brik";
				case "vcs": return "brik";
				case "tests": return "sbag";
				case "deps": return "barb";
				case "ci": return "fenc";
				case "docs": return "wood";
				default: return info.WallActorsByLevel[Math.Min(level, info.WallActorsByLevel.Length - 1)];
			}
		}

		// Outlines a folder region along the perimeter of its server-computed box,
		// so child folders sit visibly inside their parent and the wall styles the
		// district by its role.
		List<Actor> BuildFolderWalls(World w, Region region)
		{
			var walls = new List<Actor>();
			var (ox, oy) = coords.RegionOrigin(region);
			var width = region.Size.W;
			var height = region.Size.H;
			var wall = WallActorForRole(region.Role, region.Level);
			var name = Basename(region.Path);

			// One-cell opening on the west wall at its midpoint, so the folder is
			// reachable; agents already approach from this cell (see ApplyAgents).
			// Skipped when the folder is too short to fit a non-corner door.
			var hasDoor = height >= 3;
			var doorY = height / 2;

			for (var dy = 0; dy < height; dy++)
			{
				for (var dx = 0; dx < width; dx++)
				{
					if (dx != 0 && dy != 0 && dx != width - 1 && dy != height - 1)
						continue;

					if (hasDoor && dx == 0 && dy == doorY)
						continue;

					var cell = new CPos(ox + dx, oy + dy);
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

		// The verb is the primary read on the unit's label (READ, EDIT, BUILD,
		// DESTROY, FETCH, SPAWN, ...); fall back to the coarse direction.
		static string ActivityLabel(FileActivity activity)
		{
			if (activity == null)
				return "";

			var verb = string.IsNullOrEmpty(activity.Verb) ? activity.Direction : activity.Verb;
			return (verb ?? "").ToUpperInvariant();
		}

		// Paints a "ctx NN%" readout over the terminal that reddens as the agent's
		// context window fills (green -> amber -> red), so the base visibly browns
		// out as it runs low on headroom. Cleared when the fill is unknown.
		void UpdateContextReadout(string terminal, double? fraction)
		{
			if (!islands.TryGetValue(terminal, out var island) || !island.IsInWorld)
				return;

			var label = island.TraitOrDefault<ClankerLabel>();
			if (label == null)
				return;

			if (fraction == null)
			{
				label.Label = "";
				label.LabelColor = null;
				return;
			}

			var pct = (int)Math.Round(Math.Clamp(fraction.Value, 0, 1) * 100);
			label.Label = $"ctx {pct}%";
			label.LabelColor = fraction.Value >= 0.85 ? Color.Red
				: fraction.Value >= 0.6 ? Color.Yellow
				: Color.Lime;
		}

		// Fires once when an agent's action fails: an explosion plus red "FAILED"
		// over the unit. Success is left silent -- the verb label already shows
		// ongoing work, so a per-action success cue would only add noise. Keyed
		// on the (verb|path|ok) signature so it does not re-fire while the
		// snapshot for that same action keeps arriving each tick.
		void FireActivityFx(World w, Actor unit, string id, FileActivity activity)
		{
			var sig = activity == null ? "" : $"{activity.Verb}|{activity.Path}|{activity.Ok}";
			agentActivitySig.TryGetValue(id, out var prev);
			agentActivitySig[id] = sig;

			if (sig == "" || sig == prev || activity.Ok != false || !unit.IsInWorld)
				return;

			var pos = unit.CenterPosition;
			w.Add(new SpriteEffect(pos, w, "explosion", "building", "effect"));
			w.Add(new FloatingText(pos, Color.Red, "FAILED", 25));
		}

		// Places one civilian building per touched file inside the folder's file
		// strip (the variant is chosen by the file's role), and removes buildings
		// for files that are gone. A hashed slot with linear probing keeps each
		// file put and stops two buildings landing on the same footprint.
		void ApplyFiles(World w, List<FolderFiles> files)
		{
			if (info.FileActors.Length == 0)
				return;

			foreach (var folder in files)
			{
				if (folder.Entries == null || !folderRegions.TryGetValue(folder.Dir, out var region))
					continue;

				var cells = FileSlotCells(w, region);
				if (cells.Count == 0)
					continue;

				if (!placedFiles.TryGetValue(folder.Dir, out var placed))
				{
					placed = new Dictionary<string, Actor>();
					placedFiles[folder.Dir] = placed;
				}

				var occupied = new HashSet<CPos>();
				foreach (var a in placed.Values)
					if (a.IsInWorld)
						occupied.Add(a.Location);

				var current = new HashSet<string>();
				foreach (var entry in folder.Entries)
				{
					current.Add(entry.Path);
					if (placed.ContainsKey(entry.Path))
						continue;

					var start = SlotFor(entry.Path, cells.Count);
					var chosen = -1;
					for (var i = 0; i < cells.Count; i++)
					{
						var idx = (start + i) % cells.Count;
						if (!occupied.Contains(cells[idx]))
						{
							chosen = idx;
							break;
						}
					}

					if (chosen < 0)
						continue; // the file strip is full

					occupied.Add(cells[chosen]);
					var actorName = FileActorForRole(entry.Role);
					var building = w.CreateActor(actorName,
					[
						new LocationInit(cells[chosen]),
						new OwnerInit(owner),
					]);
					var label = building.TraitOrDefault<ClankerLabel>();
					if (label != null)
						label.Label = FileLabel(entry);
					placed[entry.Path] = building;
				}

				var gone = new List<string>();
				foreach (var path in placed.Keys)
					if (!current.Contains(path))
						gone.Add(path);

				foreach (var path in gone)
				{
					if (placed[path].IsInWorld)
						placed[path].Dispose();

					placed.Remove(path);
				}
			}
		}

		// The placement slots in a folder's server-reserved file strip. Columns are
		// stepped by two so the two-wide house sprites do not overlap.
		List<CPos> FileSlotCells(World w, Region region)
		{
			var list = new List<CPos>();
			if (region.FileArea == null)
				return list;

			var area = region.FileArea;
			for (var row = 0; row < area.Rows; row++)
				for (var col = 0; col < area.Cols; col += 2)
				{
					var (x, y) = coords.ToCell(area.X + col, area.Y + row);
					var cell = new CPos(x, y);
					if (w.Map.Contains(cell))
						list.Add(cell);
				}

			return list;
		}

		// Pick a building variant by the file's role, so files of the same kind
		// share a silhouette (all tests alike, all configs alike) instead of
		// varying by extension hash. Indices map into FileActors; build artifacts
		// reuse the last variant. Richer, role-iconic buildings (barracks for
		// tests, a refinery for a manifest) need a wider file strip and are
		// tracked as a follow-up.
		string FileActorForRole(string role)
		{
			var i = role switch
			{
				"source" => 0,
				"test" => 1,
				"config" => 2,
				"manifest" => 3,
				"docs" => 4,
				"build" => 5,
				_ => 6,
			};
			return info.FileActors[Math.Min(i, info.FileActors.Length - 1)];
		}

		// Shown over a file's house while it is selected: basename and size.
		static string FileLabel(FileEntry entry)
		{
			return $"{Basename(entry.Name ?? entry.Path)} ({FormatSize(entry.Size)})";
		}

		static string FormatSize(long bytes)
		{
			if (bytes < 1024)
				return $"{bytes} B";
			if (bytes < 1024 * 1024)
				return $"{bytes / 1024.0:0.#} KB";
			return $"{bytes / (1024.0 * 1024.0):0.#} MB";
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
						UpdateContextReadout(snap.Terminal, snap.ContextFraction);
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
				if (snap.Activity != null && folderRegions.TryGetValue(snap.Activity.Dir, out var region))
				{
					// Park just outside the folder's west wall: the interior is sealed by
					// the perimeter walls, so the unit approaches the folder rather than
					// trying to path into a blocked cell.
					var (fx, fy) = coords.RegionOrigin(region);
					var folderTarget = new CPos(fx - 1, fy + (region.Size.H / 2));
					if (w.Map.Contains(folderTarget))
						target = folderTarget;
				}

				if (agentTarget[snap.Id] != target)
				{
					unit.QueueActivity(false, new Move(unit, target));
					agentTarget[snap.Id] = target;
				}

				FireActivityFx(w, unit, snap.Id, snap.Activity);

				if (agentLabels.TryGetValue(snap.Id, out var label) && label != null)
					label.Label = ActivityLabel(snap.Activity);
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
				agentActivitySig.Remove(id);
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
					foreach (var building in placed.Values)
						if (building.IsInWorld)
							building.Dispose();

					placedFiles.Remove(path);
				}

				folderWalls.Remove(path);
				folderRegions.Remove(path);
			}
		}

		void RebuildConnectors(World w)
		{
			var list = new List<(WPos, WPos, Color)>();

			// Parent -> child folder edges (the directory tree).
			foreach (var kv in folderRegions)
			{
				var parent = ParentOf(kv.Key);
				if (parent != null && folderRegions.TryGetValue(parent, out var pr))
					list.Add((FolderCenter(w, pr), FolderCenter(w, kv.Value), Color.Gray));
			}

			// Terminal -> the folder its agent is working in right now.
			foreach (var kv in activeLinks)
			{
				if (islands.TryGetValue(kv.Key, out var island) && island.IsInWorld
					&& folderRegions.TryGetValue(kv.Value, out var fr))
					list.Add((island.CenterPosition, FolderCenter(w, fr), Color.Cyan));
			}

			connectors = list;
		}

		string ParentOf(string path)
		{
			string best = null;
			foreach (var other in folderRegions.Keys)
			{
				if (other == path || !path.StartsWith(other + "/", StringComparison.Ordinal))
					continue;

				if (best == null || other.Length > best.Length)
					best = other;
			}

			return best;
		}

		WPos FolderCenter(World w, Region region)
		{
			var (ox, oy) = coords.RegionOrigin(region);
			return w.Map.CenterOfCell(new CPos(ox + (region.Size.W / 2), oy + (region.Size.H / 2)));
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
