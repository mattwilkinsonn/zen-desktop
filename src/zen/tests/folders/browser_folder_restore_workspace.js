/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_folder_restore_repairs_stale_tab_workspace() {
  await gZenWorkspaces.promiseInitialized;
  const originalSpace = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace("Folder restore");
  const folderId = "zen-folder-restore-workspace-test";
  const tabs = [true, false].map(zenIsEmpty => ({
    groupId: folderId,
    pinned: true,
    zenIsEmpty,
    zenWorkspace: originalSpace,
  }));
  const ungroupedTab = { zenWorkspace: originalSpace };
  const missingFolderTab = {
    groupId: "missing-folder",
    zenWorkspace: originalSpace,
  };

  try {
    gZenWorkspaces.restoreWorkspacesFromSessionStore({
      folders: [{ id: folderId, workspaceId: space.uuid }],
      tabs: [...tabs, ungroupedTab, missingFolderTab],
    });
    for (const tabData of tabs) {
      Assert.equal(
        tabData.zenWorkspace,
        space.uuid,
        "The folder repairs both placeholder and real tab session data"
      );
      const tab = document.createXULElement("tab");
      gZenSessionStore.restoreInitialTabData(tab, tabData);
      Assert.equal(
        tab.getAttribute("zen-workspace-id"),
        space.uuid,
        "The repaired workspace is applied to the restored tab"
      );
    }
    Assert.equal(ungroupedTab.zenWorkspace, originalSpace);
    Assert.equal(missingFolderTab.zenWorkspace, originalSpace);

    gZenWorkspaces.beginSessionRestoreFragments();
    const node = document.createXULElement("tab-group");
    // Exercise container selection independently of the session-data repair.
    gZenWorkspaces
      .getSessionRestoreFragment({
        groupId: folderId,
        pinned: true,
        zenWorkspace: originalSpace,
      })
      .appendChild(node);
    try {
      gZenWorkspaces.flushSessionRestoreFragments();
      Assert.equal(
        node.parentElement,
        gZenWorkspaces.workspaceElement(space.uuid).pinnedTabsContainer,
        "A stale placeholder cannot pull its folder into another space"
      );
    } finally {
      node.remove();
    }
  } finally {
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await gZenWorkspaces.removeWorkspace(space.uuid);
    await gZenWorkspaces.restoreWorkspacesFromSessionStore({});
  }
});

add_task(async function test_window_restore_folder_workspace_and_undo_close() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  const spaceA = win.gZenWorkspaces.activeWorkspace;
  const spaceB = await win.gZenWorkspaces.createAndSaveWorkspace("Restore B");
  const folderId = "zen-integration-restore-folder";
  const originalRestore = win.gZenSessionStore.restoreInitialTabData;
  try {
    const state = SessionStore.getWindowState(win);
    const data = state.windows[0];
    data.tabs = [
      { entries: [{ url: "about:blank" }], index: 1 },
      ...[true, false].map((zenIsEmpty, index) => ({
        entries: [{ url: zenIsEmpty ? "about:blank" : "https://example.com/" }],
        index: 1,
        pinned: true,
        groupId: folderId,
        zenSyncId: `zen-restore-child-${index}`,
        zenIsEmpty,
        zenWorkspace: spaceB.uuid,
      })),
      {
        entries: [{ url: "https://example.org/" }], index: 1,
        pinned: true, zenEssential: true, zenWorkspace: spaceB.uuid,
        zenSyncId: "zen-restore-essential",
      },
    ];
    data.selected = 1;
    data.groups = [{ id: folderId, name: "Restored", color: "blue", pinned: true }];
    data.folders = [{
      id: folderId, name: "Restored", pinned: true, workspaceId: spaceA,
      emptyTabIds: ["zen-restore-child-0"], collapsed: false,
    }];
    // Keep the routing input stale after tab attributes are repaired. This
    // independently verifies that Tabbrowser passes the folder's groupId.
    win.gZenSessionStore.restoreInitialTabData = function (tab, tabData) {
      originalRestore.call(this, tab, tabData);
      if (tabData.groupId === folderId) {
        tabData.zenWorkspace = spaceB.uuid;
      }
    };
    const ready = BrowserTestUtils.waitForEvent(win, "SSWindowStateReady");
    SessionStore.setWindowState(win, state, true);
    await ready;
    win.gZenSessionStore.restoreInitialTabData = originalRestore;
    const folder = win.document.getElementById(folderId);
    Assert.equal(folder.parentElement,
      win.gZenWorkspaces.workspaceElement(spaceA).pinnedTabsContainer,
      "Real SessionStore restore routes the folder by its saved workspace");
    for (const tab of folder.tabs) {
      Assert.equal(tab.getAttribute("zen-workspace-id"), spaceA);
    }
    const essential = win.document.getElementById("zen-restore-essential");
    Assert.equal(essential.parentElement,
      win.gZenWorkspaces.getEssentialsSection(essential),
      "Essentials take precedence over workspace routing");
    const saved = SessionStore.getWindowState(win).windows[0];
    for (const tab of saved.tabs.filter(tab => tab.groupId === folderId)) {
      Assert.equal(tab.zenWorkspace, spaceA, "The repaired workspace persists");
    }

    win.gZenFolders.changeFolderToSpace(folder, spaceB.uuid);
    await win.gZenWorkspaces.changeWorkspaceWithID(spaceB.uuid);
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    win.gBrowser.removeTabGroup(folder);
    await removed;
    const restored = BrowserTestUtils.waitForEvent(win, "SSWindowStateReady");
    const reopened = SessionStore.undoCloseTabGroup(win, folderId, win);
    await restored;
    Assert.equal(reopened.parentElement,
      win.gZenWorkspaces.workspaceElement(spaceB.uuid).pinnedTabsContainer,
      "Undo-close uses the moved workspace, not the old restore map");
    for (const tab of reopened.tabs) {
      Assert.equal(tab.getAttribute("zen-workspace-id"), spaceB.uuid);
    }
  } finally {
    win.gZenSessionStore.restoreInitialTabData = originalRestore;
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_folder_restore_map_clears_after_insertion_error() {
  const originalSpace = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace("Failed restore");
  const container = gZenWorkspaces.workspaceElement(space.uuid).pinnedTabsContainer;
  const originalInsert = container.insertBefore;
  const node = document.createXULElement("tab-group");
  try {
    gZenWorkspaces.restoreWorkspacesFromSessionStore({
      folders: [{ id: "failed-folder", workspaceId: space.uuid }],
    });
    gZenWorkspaces.beginSessionRestoreFragments();
    gZenWorkspaces.getSessionRestoreFragment({
      groupId: "failed-folder", pinned: true, zenWorkspace: originalSpace,
    }).appendChild(node);
    container.insertBefore = () => { throw new Error("restore insertion failed"); };
    Assert.throws(() => gZenWorkspaces.flushSessionRestoreFragments(),
      /restore insertion failed/);
    container.insertBefore = originalInsert;
    gZenWorkspaces.beginSessionRestoreFragments();
    gZenWorkspaces.getSessionRestoreFragment({
      groupId: "failed-folder", pinned: true, zenWorkspace: originalSpace,
    }).appendChild(node);
    gZenWorkspaces.flushSessionRestoreFragments();
    Assert.equal(node.parentElement,
      gZenWorkspaces.workspaceElement(originalSpace).pinnedTabsContainer,
      "An insertion error cannot leak the previous restore's workspace map");
  } finally {
    container.insertBefore = originalInsert;
    node.remove();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});
