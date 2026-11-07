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
    await gZenWorkspaces.restoreWorkspacesFromSessionStore({
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
