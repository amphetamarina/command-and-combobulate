import Phaser from "phaser";
import { CityScene } from "./scene.ts";
import { fetchWorld } from "./api.ts";

const app = document.getElementById("app");

function setStatus(text: string, color: string) {
  if (!app) return;
  app.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = text;
  p.style.cssText = `color:${color};font-family:monospace;padding:1rem;margin:0`;
  app.appendChild(p);
}

setStatus("scanning /proc and hashing your running binaries ...", "#e0e0f0");

try {
  const world = await fetchWorld();
  if (app) app.innerHTML = "";

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#0a0a12",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
  });

  game.scene.add("city", CityScene, true, { buildings: world.buildings });

  console.log(
    `[client] rendering ${world.buildings.length} buildings across ${world.regions.length} regions`,
  );
} catch (err) {
  setStatus(`failed to load /world: ${(err as Error).message}`, "#ff6b6b");
  throw err;
}
