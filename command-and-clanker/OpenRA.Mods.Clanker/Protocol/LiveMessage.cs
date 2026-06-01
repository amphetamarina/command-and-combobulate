using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenRA.Mods.Clanker.Protocol
{
	// Mirrors the wire format the Command & Clanker backend broadcasts over
	// WS /live (see the LiveMessage union in shared/proc-types.ts). One inbound
	// frame is one of three kinds: a full world snapshot ("world-delta"), the
	// current agents ("agents"), or the files each folder has touched ("files").

	public class TileXY
	{
		[JsonPropertyName("x")] public int X { get; set; }
		[JsonPropertyName("y")] public int Y { get; set; }
	}

	public class TileWH
	{
		[JsonPropertyName("w")] public int W { get; set; }
		[JsonPropertyName("h")] public int H { get; set; }
	}

	public class FileArea
	{
		[JsonPropertyName("x")] public int X { get; set; }
		[JsonPropertyName("y")] public int Y { get; set; }
		[JsonPropertyName("cols")] public int Cols { get; set; }
		[JsonPropertyName("rows")] public int Rows { get; set; }
	}

	public class Region
	{
		[JsonPropertyName("path")] public string Path { get; set; }
		[JsonPropertyName("kind")] public string Kind { get; set; }
		[JsonPropertyName("label")] public string Label { get; set; }
		[JsonPropertyName("role")] public string Role { get; set; }
		[JsonPropertyName("origin")] public TileXY Origin { get; set; }
		[JsonPropertyName("size")] public TileWH Size { get; set; }
		[JsonPropertyName("tint")] public long Tint { get; set; }
		[JsonPropertyName("level")] public int Level { get; set; }
		[JsonPropertyName("fileArea")] public FileArea FileArea { get; set; }

		public bool IsTerminal => Kind == "terminal";
	}

	public class FileActivity
	{
		[JsonPropertyName("path")] public string Path { get; set; }
		[JsonPropertyName("dir")] public string Dir { get; set; }
		[JsonPropertyName("direction")] public string Direction { get; set; }
		[JsonPropertyName("verb")] public string Verb { get; set; }

		// "pending" while the action is still running, then "ok" or "error"
		// once its result arrives.
		[JsonPropertyName("outcome")] public string Outcome { get; set; }
	}

	public class AgentSnapshot
	{
		[JsonPropertyName("id")] public string Id { get; set; }
		[JsonPropertyName("terminal")] public string Terminal { get; set; }
		[JsonPropertyName("kind")] public string Kind { get; set; }
		[JsonPropertyName("parent")] public string Parent { get; set; }
		[JsonPropertyName("tool")] public string Tool { get; set; }
		[JsonPropertyName("label")] public string Label { get; set; }
		[JsonPropertyName("activity")] public FileActivity Activity { get; set; }
		[JsonPropertyName("recent")] public List<string> Recent { get; set; }
		[JsonPropertyName("contextFraction")] public double? ContextFraction { get; set; }
		[JsonPropertyName("lastMessage")] public string LastMessage { get; set; }

		public bool IsSubagent => Kind == "subagent";
	}

	public class FileEntry
	{
		[JsonPropertyName("path")] public string Path { get; set; }
		[JsonPropertyName("name")] public string Name { get; set; }
		[JsonPropertyName("size")] public long Size { get; set; }
		[JsonPropertyName("direction")] public string Direction { get; set; }
		[JsonPropertyName("role")] public string Role { get; set; }
		[JsonPropertyName("ts")] public long Ts { get; set; }
	}

	public class FolderFiles
	{
		[JsonPropertyName("dir")] public string Dir { get; set; }
		[JsonPropertyName("entries")] public List<FileEntry> Entries { get; set; }
	}

	public class LiveMessage
	{
		[JsonPropertyName("kind")] public string Kind { get; set; }
		[JsonPropertyName("capturedAt")] public long CapturedAt { get; set; }
		[JsonPropertyName("regions")] public List<Region> Regions { get; set; }
		[JsonPropertyName("agents")] public List<AgentSnapshot> Agents { get; set; }
		[JsonPropertyName("files")] public List<FolderFiles> Files { get; set; }

		static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

		// Returns null for unparseable frames so the bridge can skip them
		// instead of tearing down the socket on one malformed message.
		public static LiveMessage Parse(string json)
		{
			try
			{
				return JsonSerializer.Deserialize<LiveMessage>(json, Options);
			}
			catch (JsonException)
			{
				return null;
			}
		}
	}
}
