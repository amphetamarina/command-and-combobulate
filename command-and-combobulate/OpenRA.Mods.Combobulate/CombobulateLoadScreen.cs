using System.Linq;
using OpenRA.FileSystem;
using OpenRA.Graphics;
using OpenRA.Mods.Common.LoadScreens;
using OpenRA.Primitives;

namespace OpenRA.Mods.Combobulate
{
	// Draws a single image centered on screen plus the loadscreen-loading phrases.
	// Unlike LogoStripeLoadScreen (which tiles a "stripe" region across the full
	// width and so mangles a plain banner), this shows the image exactly once.
	// Image size defaults to 512x256 and can be overridden with Width/Height in
	// the LoadScreen block.
	public sealed class CombobulateLoadScreen : SheetLoadScreen
	{
		[FluentReference]
		const string Loading = "loadscreen-loading";

		Sprite image;
		float2 pos;
		Sheet lastSheet;
		int lastDensity;
		Size lastResolution;
		int imageWidth = 512;
		int imageHeight = 256;
		string[] messages = [];

		public override void Init(Manifest manifest, IReadOnlyFileSystem fileSystem)
		{
			base.Init(manifest, fileSystem);

			if (Info.TryGetValue("Width", out var w) && int.TryParse(w, out var wv))
				imageWidth = wv;
			if (Info.TryGetValue("Height", out var h) && int.TryParse(h, out var hv))
				imageHeight = hv;

			messages = FluentProvider.GetMessage(Loading).Split(',').Select(x => x.Trim()).ToArray();
		}

		public override void DisplayInner(Renderer r, Sheet s, int density)
		{
			if (s != lastSheet || density != lastDensity)
			{
				lastSheet = s;
				lastDensity = density;
				image = CreateSprite(s, density, new Rectangle(0, 0, imageWidth, imageHeight));
			}

			if (r.Resolution != lastResolution)
			{
				lastResolution = r.Resolution;
				pos = new float2((r.Resolution.Width - imageWidth) / 2, (r.Resolution.Height - imageHeight) / 2);
			}

			if (image != null)
				r.RgbaSpriteRenderer.DrawSprite(image, pos);

			if (r.Fonts != null && messages.Length > 0)
			{
				var text = messages.Random(Game.CosmeticRandom);
				var textSize = r.Fonts["Bold"].Measure(text);
				r.Fonts["Bold"].DrawText(text, new float2(r.Resolution.Width - textSize.X - 20, r.Resolution.Height - textSize.Y - 20), Color.White);
			}
		}
	}
}
