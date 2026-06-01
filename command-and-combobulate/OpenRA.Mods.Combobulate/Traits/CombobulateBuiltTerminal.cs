using OpenRA.Traits;

namespace OpenRA.Mods.Combobulate.Traits
{
	[Desc("On a player-built Terminal building, asks the backend to create a",
		"terminal and claims the returned id so this building becomes that",
		"terminal's island. Bridge-spawned islands already carry an id and are",
		"left alone.")]
	public class CombobulateBuiltTerminalInfo : TraitInfo, Requires<CombobulateTerminalRefInfo>
	{
		public override object Create(ActorInitializer init) { return new CombobulateBuiltTerminal(); }
	}

	public class CombobulateBuiltTerminal : INotifyAddedToWorld
	{
		void INotifyAddedToWorld.AddedToWorld(Actor self)
		{
			var termRef = self.Trait<CombobulateTerminalRef>();
			if (!string.IsNullOrEmpty(termRef.TerminalId))
				return;

			CombobulateBackend.PostForId("/term/new", new { cols = 80, rows = 24 }, id =>
			{
				if (!self.IsInWorld)
					return;

				termRef.TerminalId = id;
				self.World.WorldActor.TraitOrDefault<CombobulateBridge>()?.RegisterPlayerTerminal(id, self);
			});
		}
	}
}
