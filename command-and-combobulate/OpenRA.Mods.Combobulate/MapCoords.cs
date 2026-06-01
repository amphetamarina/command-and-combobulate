using OpenRA.Mods.Combobulate.Protocol;

namespace OpenRA.Mods.Combobulate
{
	// Translates the backend's unbounded tile grid (Region.origin / fileArea,
	// laid out by the spiral slot allocator in server/world-builder.ts) onto a
	// fixed OpenRA map. A constant offset recenters the world; callers wrap the
	// returned coordinates in CPos. Kept free of engine types so the mapping is
	// unit-testable on its own.
	public readonly struct MapCoords
	{
		readonly int offsetX;
		readonly int offsetY;

		public MapCoords(int offsetX, int offsetY)
		{
			this.offsetX = offsetX;
			this.offsetY = offsetY;
		}

		public (int X, int Y) ToCell(int tileX, int tileY)
		{
			return (offsetX + tileX, offsetY + tileY);
		}

		public (int X, int Y) RegionOrigin(Region region)
		{
			return ToCell(region.Origin.X, region.Origin.Y);
		}
	}
}
