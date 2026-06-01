using OpenRA.Mods.Combobulate.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Widgets;

namespace OpenRA.Mods.Combobulate.Widgets.Logic
{
	// Wires the native-chrome controls around the terminal grid: a button that
	// cycles which terminal the panel mirrors (t1 -> ... -> All), a composer that
	// sends a typed line to the bound agent(s), and a close button that dismisses
	// the panel. The grid itself is painted by CombobulateTerminalWidget; this logic
	// only drives the chrome and reconciles it with the map selection.
	public class CombobulateTerminalLogic : ChromeLogic
	{
		readonly World world;
		readonly CombobulateBridge bridge;
		readonly Widget panel;
		string lastSelection;

		[ObjectCreator.UseCtor]
		public CombobulateTerminalLogic(Widget widget, World world)
		{
			this.world = world;
			bridge = world.WorldActor.TraitOrDefault<CombobulateBridge>();

			panel = widget.Get("PANEL");

			var mode = widget.Get<ButtonWidget>("TERM_MODE");
			mode.GetText = () =>
			{
				var bound = bridge?.BoundTerminal;
				if (string.IsNullOrEmpty(bound))
					return "—";

				return bound == CombobulateBridge.AllTerminals ? "All" : bound;
			};
			mode.OnClick = () => bridge?.CycleBoundTerminal();

			var composer = widget.Get<TextFieldWidget>("TERM_COMPOSER");
			composer.OnEnterKey = _ =>
			{
				if (composer.Text != "")
				{
					bridge?.SendComposed(composer.Text.Trim());
					composer.Text = "";
				}

				composer.YieldKeyboardFocus();
				return true;
			};
			composer.OnEscKey = _ =>
			{
				composer.YieldKeyboardFocus();
				return true;
			};

			var close = widget.Get<ButtonWidget>("TERM_CLOSE");
			close.OnClick = () =>
			{
				bridge?.SetBoundTerminal(null);

				// Clear the selection too, so the next Tick does not immediately
				// re-bind the panel to the still-selected terminal island.
				world.Selection.Clear();
			};
		}

		public override void Tick()
		{
			if (bridge == null)
				return;

			// Selecting a terminal island on the map mirrors it in the panel. The
			// mode button can then cycle away (including to All); a fresh selection
			// re-binds. Acting only on change lets the button override map-follow.
			var selected = SelectedTerminal();
			if (selected != lastSelection)
			{
				lastSelection = selected;
				if (!string.IsNullOrEmpty(selected))
					bridge.SetBoundTerminal(selected);
			}

			panel.Visible = !string.IsNullOrEmpty(bridge.BoundTerminal);
		}

		// The backend id of the first selected terminal island, or null if none.
		string SelectedTerminal()
		{
			foreach (var a in world.Selection.Actors)
			{
				if (!a.IsInWorld)
					continue;

				var r = a.TraitOrDefault<CombobulateTerminalRef>();
				if (r != null)
					return r.TerminalId;
			}

			return null;
		}
	}
}
