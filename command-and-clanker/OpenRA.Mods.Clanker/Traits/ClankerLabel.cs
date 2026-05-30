using System.Collections.Generic;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Clanker.Traits
{
	[Desc("Floating text over a clanker agent unit, set at runtime by ClankerBridge",
		"to show what the agent is doing right now (READ / WRITE / RUN).")]
	public class ClankerLabelInfo : WithDecorationBaseInfo
	{
		public readonly string Font = "TinyBold";

		[Desc("Text colour.")]
		public readonly Color Color = Color.White;

		public override object Create(ActorInitializer init) { return new ClankerLabel(init.Self, this); }

		public override void RulesetLoaded(Ruleset rules, ActorInfo ai)
		{
			if (!Game.ModData.GetOrCreate<Fonts>().FontList.ContainsKey(Font))
				throw new YamlException($"Font '{Font}' is not listed in the mod.yaml's Fonts section");

			base.RulesetLoaded(rules, ai);
		}
	}

	public class ClankerLabel : WithDecorationBase<ClankerLabelInfo>
	{
		readonly SpriteFont font;

		// Written by ClankerBridge on the game thread; read here when rendering.
		// A torn read of a string reference is harmless, so no synchronization.
		public string Label = "";

		// Optional per-instance colour override (e.g. a context readout reddening
		// as it fills); falls back to the actor's configured colour when null.
		public Color? LabelColor = null;

		public ClankerLabel(Actor self, ClankerLabelInfo info)
			: base(self, info)
		{
			font = Game.Renderer.Fonts[info.Font];
		}

		protected override IEnumerable<IRenderable> RenderDecoration(Actor self, WorldRenderer wr, int2 screenPos)
		{
			if (string.IsNullOrEmpty(Label))
				return [];

			var size = font.Measure(Label);
			return [new UITextRenderable(font, self.CenterPosition, screenPos - (size / 2), 0, LabelColor ?? Info.Color, Label)];
		}
	}
}
