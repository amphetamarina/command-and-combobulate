using OpenRA.Graphics;
using OpenRA.Traits;
using OpenRA.Widgets;

namespace OpenRA.Mods.Combobulate.Traits
{
	[TraitLocation(SystemActors.World)]
	[Desc("Loads the Command & Combobulate interactive terminal panel into the ingame UI when a game starts.")]
	public class CombobulateSidebarLoaderInfo : TraitInfo
	{
		[Desc("Interactive terminal panel to load into the UI root.")]
		public readonly string TerminalWidget = "COMBOBULATE_TERMINAL";

		public override object Create(ActorInitializer init) { return new CombobulateSidebarLoader(this); }
	}

	public class CombobulateSidebarLoader : IWorldLoaded
	{
		readonly CombobulateSidebarLoaderInfo info;

		public CombobulateSidebarLoader(CombobulateSidebarLoaderInfo info)
		{
			this.info = info;
		}

		void IWorldLoaded.WorldLoaded(World world, WorldRenderer wr)
		{
			if (world.Type == WorldType.Shellmap)
				return;

			// Defer until after this tick: LoadWidgetAtGameStart.WorldLoaded calls
			// Ui.ResetAll and loads the ingame root during world load, so adding the
			// panel afterwards puts it on top and keeps it from being wiped.
			Game.RunAfterTick(() => Game.LoadWidget(world, info.TerminalWidget, Ui.Root, new WidgetArgs()));
		}
	}
}
