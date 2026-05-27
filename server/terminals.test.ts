import { test, expect } from "bun:test";
import xterm from "@xterm/headless";
import { readGrid } from "./terminals.ts";

function write(view: InstanceType<typeof xterm.Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => view.write(data, resolve));
}

test("readGrid resolves cursor moves and overwrites into a screen grid", async () => {
  const view = new xterm.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  await write(view, "\x1b[2J\x1b[H"); // clear + home
  await write(view, "hello\r\nworld");
  await write(view, "\x1b[1;1HHELLO"); // jump to row 1 col 1, overwrite

  const grid = readGrid(view);
  expect(grid.cols).toBe(20);
  expect(grid.rows).toBe(4);
  expect(grid.lines[0]).toBe("HELLO");
  expect(grid.lines[1]).toBe("world");
  // After the overwrite the cursor sits just past "HELLO" on the first row.
  expect(grid.cursorY).toBe(0);
  expect(grid.cursorX).toBe(5);
});

test("readGrid reflects a later resize", async () => {
  const view = new xterm.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  view.resize(30, 6);
  await write(view, "x");

  const grid = readGrid(view);
  expect(grid.cols).toBe(30);
  expect(grid.rows).toBe(6);
  expect(grid.lines.length).toBe(6);
});
