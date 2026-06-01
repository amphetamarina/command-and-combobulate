using System;
using OpenRA.Mods.Clanker.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Primitives;
using OpenRA.Widgets;

namespace OpenRA.Mods.Clanker.Widgets
{
	// A live, interactive terminal view. The backend resolves the PTY into a
	// screen grid (see ClankerBridge.TerminalGrid); this widget paints each cell
	// at a fixed advance and forwards keystrokes back to the PTY. It is invisible
	// until a terminal island is selected, and follows the selection itself.
	//
	// The cell size is measured from the font: for a monospace font every glyph
	// advance is identical, so column positions stay perfectly aligned.
	public class ClankerTerminalWidget : Widget
	{
		public readonly string Font = "ClankerTerm";
		public readonly int LineGap = 2;
		public readonly int Padding = 6;
		public readonly Color Background = Color.FromArgb(235, 12, 14, 16);
		public readonly Color Foreground = Color.FromArgb(220, 220, 220);

		readonly ClankerBridge bridge;
		int lastResizeCols;
		int lastResizeRows;

		[ObjectCreator.UseCtor]
		public ClankerTerminalWidget(World world)
		{
			bridge = world.WorldActor.TraitOrDefault<ClankerBridge>();
		}

		// Pixel size of one character cell, taken from the font's own metrics.
		(int W, int H) CellSize()
		{
			var font = Game.Renderer.Fonts[Font];
			var m = font.Measure("M");
			return (Math.Max(1, m.X), Math.Max(1, m.Y + LineGap));
		}

		public override void Tick()
		{
			if (bridge == null)
				return;

			// The panel binding is driven by ClankerTerminalLogic; here we only keep
			// the streamed PTY sized to the grid. With no streamed terminal (the
			// panel is dismissed or showing the All view) there is nothing to size.
			if (string.IsNullOrEmpty(bridge.StreamedTerminal))
			{
				if (HasKeyboardFocus)
					YieldKeyboardFocus();

				return;
			}

			var grid = bridge.TerminalGrid;
			if (grid == null)
				return;

			// Keep the PTY sized to what we can actually show, but only ask once
			// per target size so we do not spam resizes while the backend catches up.
			var (cw, ch) = CellSize();
			var cols = Math.Max(1, (Bounds.Width - (2 * Padding)) / cw);
			var rows = Math.Max(1, (Bounds.Height - (2 * Padding)) / ch);
			if ((grid.Cols != cols || grid.Rows != rows) && (cols != lastResizeCols || rows != lastResizeRows))
			{
				bridge.SendTerminalResize(cols, rows);
				lastResizeCols = cols;
				lastResizeRows = rows;
			}
		}

		public override void Draw()
		{
			if (bridge == null)
				return;

			var font = Game.Renderer.Fonts[Font];
			var rb = RenderBounds;
			WidgetUtils.FillRectWithColor(rb, Background);

			var ox = rb.X + Padding;
			var oy = rb.Y + Padding;

			// The All view has no single PTY to mirror; show what the composer targets.
			if (bridge.BoundTerminal == ClankerBridge.AllTerminals)
			{
				font.DrawTextWithContrast(
					$"All terminals — input broadcasts to {bridge.TerminalIds.Count} agent(s)",
					new float2(ox, oy), Foreground, Color.Black, 1);
				return;
			}

			var grid = bridge.TerminalGrid;
			if (grid == null)
			{
				font.DrawTextWithContrast("connecting to terminal…",
					new float2(ox, oy), Foreground, Color.Black, 1);
				return;
			}

			var (cw, ch) = CellSize();

			for (var row = 0; row < grid.Lines.Length; row++)
			{
				var line = grid.Lines[row];
				var y = oy + (row * ch);
				for (var col = 0; col < line.Length; col++)
				{
					var c = line[col];
					if (c == ' ' || c == '\0')
						continue;

					font.DrawText(c.ToString(), new float2(ox + (col * cw), y), Foreground);
				}
			}

			if (HasKeyboardFocus)
			{
				var cx = ox + (grid.CursorX * cw);
				var cy = oy + (grid.CursorY * ch);
				WidgetUtils.FillRectWithColor(new Rectangle(cx, cy + ch - 2, cw, 2), Foreground);
			}
		}

		public override bool HandleMouseInput(MouseInput mi)
		{
			// Pass clicks through to the map when no terminal is on screen.
			if (string.IsNullOrEmpty(bridge?.StreamedTerminal) || mi.Event != MouseInputEvent.Down)
				return false;

			if (!RenderBounds.Contains(mi.Location))
				return false;

			return TakeKeyboardFocus();
		}

		public override bool HandleKeyPress(KeyInput e)
		{
			if (!HasKeyboardFocus || e.Event == KeyInputEvent.Up)
				return false;

			var seq = Encode(e);
			if (seq == null)
				return false; // printable character: delivered via HandleTextInput

			bridge?.SendTerminalInput(seq);
			return true;
		}

		public override bool HandleTextInput(string text)
		{
			if (!HasKeyboardFocus || string.IsNullOrEmpty(text))
				return false;

			bridge?.SendTerminalInput(text);
			return true;
		}

		// Map non-printable keys to the byte sequences a PTY expects. Returns null
		// for ordinary characters so they arrive as text input instead.
		static string Encode(KeyInput e)
		{
			if (e.Modifiers.HasModifier(Modifiers.Ctrl) && e.Key >= Keycode.A && e.Key <= Keycode.Z)
				return ((char)(e.Key - Keycode.A + 1)).ToString();

			switch (e.Key)
			{
				case Keycode.RETURN:
				case Keycode.KP_ENTER: return "\r";
				case Keycode.BACKSPACE: return "\x7f";
				case Keycode.TAB: return "\t";
				case Keycode.ESCAPE: return "\x1b";
				case Keycode.UP: return "\x1b[A";
				case Keycode.DOWN: return "\x1b[B";
				case Keycode.RIGHT: return "\x1b[C";
				case Keycode.LEFT: return "\x1b[D";
				case Keycode.HOME: return "\x1b[H";
				case Keycode.END: return "\x1b[F";
				case Keycode.DELETE: return "\x1b[3~";
				case Keycode.PAGEUP: return "\x1b[5~";
				case Keycode.PAGEDOWN: return "\x1b[6~";
				default: return null;
			}
		}
	}
}
