using OpenRA.Mods.Common.Widgets;
using OpenRA.Widgets;

namespace OpenRA.Mods.Clanker.Widgets.Logic
{
	// The Command & Clanker shell menu: one button that boots straight into the
	// canvas map (no lobby), plus Quit. Replaces the stock main menu via the
	// world's LoadWidgetAtGameStart.ShellmapRoot override.
	public class ClankerMenuLogic : ChromeLogic
	{
		[ObjectCreator.UseCtor]
		public ClankerMenuLogic(Widget widget)
		{
			widget.Get<ButtonWidget>("LAUNCH").OnClick = () => Game.LoadMap("clanker-canvas");
			widget.Get<ButtonWidget>("QUIT").OnClick = Game.Exit;
		}
	}
}
