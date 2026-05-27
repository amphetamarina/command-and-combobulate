using OpenRA.Traits;

namespace OpenRA.Mods.Clanker.Traits
{
	[Desc("On a player-built Terminal building, asks the backend to create a",
		"terminal and claims the returned id so this building becomes that",
		"terminal's island. Bridge-spawned islands already carry an id and are",
		"left alone.")]
	public class ClankerBuiltTerminalInfo : TraitInfo, Requires<ClankerTerminalRefInfo>
	{
		public override object Create(ActorInitializer init) { return new ClankerBuiltTerminal(); }
	}

	public class ClankerBuiltTerminal : INotifyAddedToWorld
	{
		void INotifyAddedToWorld.AddedToWorld(Actor self)
		{
			var termRef = self.Trait<ClankerTerminalRef>();
			if (!string.IsNullOrEmpty(termRef.TerminalId))
				return;

			ClankerBackend.PostForId("/term/new", new { cols = 80, rows = 24 }, id =>
			{
				if (!self.IsInWorld)
					return;

				termRef.TerminalId = id;
				self.World.WorldActor.TraitOrDefault<ClankerBridge>()?.RegisterPlayerTerminal(id, self);
			});
		}
	}
}
