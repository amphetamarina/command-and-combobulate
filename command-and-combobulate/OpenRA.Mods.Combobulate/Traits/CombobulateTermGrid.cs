namespace OpenRA.Mods.Combobulate.Traits
{
	// An immutable snapshot of a terminal's resolved screen, produced by the
	// bridge from /termview frames and read by the terminal widget. Replaced
	// wholesale on each frame so readers never see a half-updated grid.
	public sealed class CombobulateTermGrid
	{
		public string[] Lines { get; init; } = System.Array.Empty<string>();
		public int Cols { get; init; }
		public int Rows { get; init; }
		public int CursorX { get; init; }
		public int CursorY { get; init; }
	}
}
