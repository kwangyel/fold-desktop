import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { closeActiveTab } from "./closeActiveTab";
import { isTauri } from "./git";

export async function setupAppMenu(): Promise<void> {
  if (!isTauri()) return;

  const closeTab = await MenuItem.new({
    id: "close-tab",
    text: "Close Tab",
    accelerator: "CmdOrCtrl+W",
    action: () => {
      closeActiveTab();
    },
  });

  const fileMenu = await Submenu.new({
    text: "File",
    items: [closeTab],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });

  const items = [fileMenu, editMenu, windowMenu];

  if (navigator.platform.toLowerCase().includes("mac")) {
    const appMenu = await Submenu.new({
      text: "Conductor Clone",
      items: [
        await PredefinedMenuItem.new({
          item: { About: { name: "Conductor Clone", version: "0.1.0" } },
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Hide" }),
        await PredefinedMenuItem.new({ item: "HideOthers" }),
        await PredefinedMenuItem.new({ item: "ShowAll" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Quit" }),
      ],
    });
    items.unshift(appMenu);
  }

  const menu = await Menu.new({ items });
  await menu.setAsAppMenu();
}
