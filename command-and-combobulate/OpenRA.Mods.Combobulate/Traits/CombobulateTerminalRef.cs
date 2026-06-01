using System.Collections.Generic;
using OpenRA.Traits;

namespace OpenRA.Mods.Combobulate.Traits
{
	[Desc("Marks a terminal-island building with its backend terminal id and the",
		"agent's recent action log, so the sidebar can read them when it is selected.")]
	public class CombobulateTerminalRefInfo : TraitInfo
	{
		public override object Create(ActorInitializer init) { return new CombobulateTerminalRef(init); }
	}

	public class CombobulateTerminalRef
	{
		// Settable so a player-built Terminal can claim its id after the backend
		// assigns one; bridge-spawned islands get it from the init.
		public string TerminalId { get; set; }

		// Set by CombobulateBridge on the game thread; read by the sidebar logic.
		public IReadOnlyList<string> Recent = new List<string>();

		// A short description of what the agent is doing right now (or "idle").
		public string Activity = "idle";

		public CombobulateTerminalRef(ActorInitializer init)
		{
			TerminalId = init.GetValue<CombobulateTerminalRefInit, string>("");
		}
	}

	public class CombobulateTerminalRefInit(string value) : ValueActorInit<string>(value), ISingleInstanceInit
	{
	}
}
