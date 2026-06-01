using System;
using System.Collections.Generic;
using OpenRA.FileSystem;
using OpenRA.Primitives;

namespace OpenRA.Mods.Combobulate.UtilityCommands
{
	// One-shot generator for the Command & Combobulate canvas: a flat, open map made
	// entirely of clear terrain, so the live world (islands, walled folders, and
	// agent units) sits on ground we control instead of fighting an RA map's
	// pre-built walls, water, and ore.
	sealed class CreateCanvasMapCommand : IUtilityCommand
	{
		string IUtilityCommand.Name => "--create-canvas";

		bool IUtilityCommand.ValidateArguments(string[] args)
		{
			return args.Length >= 2;
		}

		[Desc("OUTPUTDIR [SIZE]",
			"Create a flat, open Command & Combobulate canvas map (all clear terrain) at OUTPUTDIR.")]
		void IUtilityCommand.Run(Utility utility, string[] args)
		{
			// PlayerReference's default Color reads Game.ModData, so it must be set.
			var modData = Game.ModData = utility.ModData;

			var size = args.Length >= 3 && int.TryParse(args[2], out var parsed) ? parsed : 128;
			var terrain = modData.DefaultTerrainInfo["TEMPERAT"];
			var maxHeight = modData.GetOrCreate<MapGrid>().MaximumTerrainHeight;

			var map = new Map(modData, terrain, new Size(size + 2, size + maxHeight + 2))
			{
				Title = "Combobulate Canvas",
				Author = "Command & Combobulate",
				RequiresMod = modData.Manifest.Id,
			};

			map.SetBounds(new PPos(1, 1 + maxHeight), new PPos(size, size + maxHeight));
			map.PlayerDefinitions = new MapPlayers(map.Rules, 2).ToMiniYaml();

			var mid = size / 2;
			map.ActorDefinitions =
			[
				SpawnActor("Actor0", mid - 16, mid - 16),
				SpawnActor("Actor1", mid + 16, mid + 16),
			];

			var package = new Folder(args[1]);
			map.Save(package);

			// Reload from the saved package so the map gets a valid UID.
			map = new Map(modData, package);
			Console.WriteLine($"Created canvas map at {args[1]} (uid {map.Uid})");
		}

		static MiniYamlNode SpawnActor(string id, int x, int y)
		{
			var fields = new List<MiniYamlNode>
			{
				new("Location", new MiniYaml($"{x},{y}", new List<MiniYamlNode>())),
				new("Owner", new MiniYaml("Neutral", new List<MiniYamlNode>())),
			};

			return new MiniYamlNode(id, new MiniYaml("mpspawn", fields));
		}
	}
}
