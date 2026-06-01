using OpenRA.Mods.Common.Widgets;
using OpenRA.Widgets;

namespace OpenRA.Mods.Combobulate.Widgets.Logic
{
	// The Command & Combobulate shell menu: one button that boots straight into the
	// canvas map (no lobby), plus Quit. Replaces the stock main menu via the
	// world's LoadWidgetAtGameStart.ShellmapRoot override.
	public class CombobulateMenuLogic : ChromeLogic
	{
		[ObjectCreator.UseCtor]
		public CombobulateMenuLogic(Widget widget)
		{
			widget.Get<ButtonWidget>("LAUNCH").OnClick = () => Game.LoadMap("combobulate-canvas");
			widget.Get<ButtonWidget>("QUIT").OnClick = Game.Exit;
		}
	}
}
