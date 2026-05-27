using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using OpenRA.Support;

namespace OpenRA.Mods.Clanker
{
	// Fire-and-forget JSON POSTs to the Command & Clanker backend. Called from the
	// game thread; the request runs on a background task so it never stalls a tick.
	// Anything that changes the world comes back over the bridge's /live stream,
	// so callers do not await a response.
	public static class ClankerBackend
	{
		public static string BaseUrl = "http://127.0.0.1:3001";

		public static void Post(string path, object payload)
		{
			var url = BaseUrl + path;
			var json = JsonSerializer.Serialize(payload);
			Task.Run(async () =>
			{
				try
				{
					var client = HttpClientFactory.Create();
					using var content = new StringContent(json, Encoding.UTF8, "application/json");
					await client.PostAsync(url, content);
				}
				catch (Exception)
				{
					// Best effort: never surface backend hiccups into the game.
				}
			});
		}

		// Like Post, but reads {id} from the response and delivers it on the game
		// thread (used when a player-built Terminal needs to claim its backend id).
		public static void PostForId(string path, object payload, Action<string> onId)
		{
			var url = BaseUrl + path;
			var json = JsonSerializer.Serialize(payload);
			Task.Run(async () =>
			{
				try
				{
					var client = HttpClientFactory.Create();
					using var content = new StringContent(json, Encoding.UTF8, "application/json");
					var response = await client.PostAsync(url, content);
					var body = await response.Content.ReadAsStringAsync();
					using var doc = JsonDocument.Parse(body);
					if (doc.RootElement.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String)
					{
						var id = idEl.GetString();
						if (!string.IsNullOrEmpty(id))
							Game.RunAfterTick(() => onId(id));
					}
				}
				catch (Exception)
				{
					// Best effort.
				}
			});
		}
	}
}
