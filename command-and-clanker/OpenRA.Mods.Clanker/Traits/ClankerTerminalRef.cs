using System.Collections.Generic;
using OpenRA.Traits;

namespace OpenRA.Mods.Clanker.Traits
{
	[Desc("Marks a terminal-island building with its backend terminal id and the",
		"agent's recent action log, so the sidebar can read them when it is selected.")]
	public class ClankerTerminalRefInfo : TraitInfo
	{
		public override object Create(ActorInitializer init) { return new ClankerTerminalRef(init); }
	}

	public class ClankerTerminalRef
	{
		// Settable so a player-built Terminal can claim its id after the backend
		// assigns one; bridge-spawned islands get it from the init.
		public string TerminalId { get; set; }

		// Set by ClankerBridge on the game thread; read by the sidebar logic.
		public IReadOnlyList<string> Recent = new List<string>();

		// A short description of what the agent is doing right now (or "idle").
		public string Activity = "idle";

		public ClankerTerminalRef(ActorInitializer init)
		{
			TerminalId = init.GetValue<ClankerTerminalRefInit, string>("");
		}
	}

	public class ClankerTerminalRefInit(string value) : ValueActorInit<string>(value), ISingleInstanceInit
	{
	}
}
