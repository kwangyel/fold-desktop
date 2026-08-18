import { getVersion } from "@tauri-apps/api/app";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { message } from "@tauri-apps/plugin-dialog";
import { closeActiveTab } from "./closeActiveTab";
import { isTauri } from "./git";
import { clearDismissedVersion } from "./updatePrompt";
import { useAuthStore } from "../store/authStore";
import { useUpdateStore } from "../store/updateStore";

export async function setupAppMenu(): Promise<void> {
  if (!isTauri()) return;

  const version = await getVersion();

  const closeTab = await MenuItem.new({
    id: "close-tab",
    text: "Close Tab",
    accelerator: "CmdOrCtrl+W",
    action: () => {
      closeActiveTab();
    },
  });

  const signOut = await MenuItem.new({
    id: "sign-out",
    text: "Sign Out",
    action: () => {
      void useAuthStore.getState().logout();
    },
  });

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      closeTab,
      await PredefinedMenuItem.new({ item: "Separator" }),
      signOut,
    ],
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
    const checkForUpdates = await MenuItem.new({
      id: "check-for-updates",
      text: "Check for Updates…",
      action: () => {
        void (async () => {
          // Clear any prior "Later" so a manual check re-surfaces the prompt.
          clearDismissedVersion();
          await useUpdateStore.getState().runCheck();
          const s = useUpdateStore.getState();
          if (s.status === "up_to_date") {
            await message(`Fold ${s.current ?? version} is up to date.`, {
              title: "Check for Updates",
              kind: "info",
            });
          }
          // optional → UpdatePromptWatcher, mandatory → UpdateRequiredScreen.
        })();
      },
    });

    const appMenu = await Submenu.new({
      text: "Fold",
      items: [
        await PredefinedMenuItem.new({
          item: { About: { name: "Fold", version } },
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        checkForUpdates,
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
