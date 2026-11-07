/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);

// Pinned-tab context menus hit a missing Fluent id in test builds; device_sync does the same.
PromiseTestUtils.allowMatchingRejectionsGlobally(/menu-bookmark-tab/);

add_task(async function test_pin_before_load_uses_original_url() {
  const url = "https://example.com/unloaded-pin";
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    skipLoad: true,
    skipAnimation: true,
  });
  try {
    tab._originalUrl = url;
    tab.setAttribute("pending", "true");
    gBrowser.pinTab(tab);
    await gZenWindowSync.setPinnedTabState(tab);
    Assert.equal(
      tab._zenPinnedInitialState.entry.url,
      url,
      "An unloaded pin uses its real original URL instead of a blank entry"
    );

    tab._originalUrl = "about:blank";
    await gZenWindowSync.setPinnedTabState(tab);
    Assert.equal(
      tab._zenPinnedInitialState.entry.url,
      url,
      "A blank browser and history cannot overwrite a real saved pinned URL"
    );
  } finally {
    tab.removeAttribute("pending");
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_unloaded_blank_pin_repairs_when_page_loads() {
  const url = "https://example.com/committed-pin";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    gBrowser.pinTab(tab);
    await gZenWindowSync.setPinnedTabState(tab);
    tab._zenPinnedInitialState = { entry: { url: "about:blank" } };
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
    await loaded;
    Assert.equal(
      tab._zenPinnedInitialState.entry.url,
      url,
      "The real progress listener captures the first committed pin URL"
    );
    ok(!tab.hasAttribute("zen-pinned-changed"));
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_blank_pin_identity_repairs_on_first_commit() {
  const url = "https://example.com/first-pin-load";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    gBrowser.pinTab(tab);
    await gZenWindowSync.setPinnedTabState(tab);
    for (const blankUrl of ["about:blank", ""]) {
      tab._zenPinnedInitialState = { entry: { url: blankUrl } };
      // Subframe loads must not establish the pin's canonical URL.
      gZenPinnedTabManager.onLocationChange(
        tab.linkedBrowser,
        { isTopLevel: false },
        null,
        Services.io.newURI("https://example.org/subframe")
      );
      Assert.equal(tab._zenPinnedInitialState.entry.url, blankUrl);
      gZenPinnedTabManager.onLocationChange(
        tab.linkedBrowser,
        { isTopLevel: true },
        null,
        Services.io.newURI(url)
      );
      Assert.equal(
        tab._zenPinnedInitialState.entry.url,
        url,
        "The first real top-level location repairs a blank saved pin URL"
      );
      ok(!tab.hasAttribute("zen-pinned-changed"));
      gZenPinnedTabManager.onLocationChange(
        tab.linkedBrowser,
        { isTopLevel: true },
        null,
        Services.io.newURI("https://example.org/later-navigation")
      );
      Assert.equal(
        tab._zenPinnedInitialState.entry.url,
        url,
        "Later navigation must not replace a real canonical pinned URL"
      );
    }
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_reset_ignores_blank_saved_pin_url() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/pin-to-preserve"
  );
  const originalSetTabState = SessionStore.setTabState;
  let resets = 0;
  try {
    gBrowser.pinTab(tab);
    await gZenWindowSync.setPinnedTabState(tab);
    SessionStore.setTabState = () => {
      resets++;
    };
    for (const url of ["about:blank", "", undefined]) {
      tab._zenPinnedInitialState = { entry: { url } };
      gZenPinnedTabManager.resetPinnedTab(tab);
    }
    Assert.equal(resets, 0, "Restore/reset never replaces a pin with a blank URL");
    tab._zenPinnedInitialState = {
      entry: { url: "https://example.com/valid-reset" },
    };
    gZenPinnedTabManager.resetPinnedTab(tab);
    Assert.equal(resets, 1, "A real saved URL still follows the reset path");
  } finally {
    SessionStore.setTabState = originalSetTabState;
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_essential_blank_pin_repairs_in_both_windows() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  let mirror;
  try {
    gBrowser.pinTab(tab);
    await gZenWindowSync.setPinnedTabState(tab);
    await TestUtils.waitForCondition(() => {
      mirror = gZenWindowSync.getItemFromWindow(win, tab.id);
      return !!mirror;
    }, "The pinned tab has a second-window instance");
    tab.setAttribute("zen-essential", "true");
    mirror.setAttribute("zen-essential", "true");
    tab._zenPinnedInitialState = { entry: { url: "about:blank" } };
    mirror._zenPinnedInitialState = { entry: { url: "about:blank" } };
    const url = "https://example.com/essential-first-load";
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
    await loaded;
    Assert.equal(tab._zenPinnedInitialState.entry.url, url);
    Assert.equal(mirror._zenPinnedInitialState.entry.url, url,
      "Canonical URL repair propagates to the second window");
    ok(!tab.hasAttribute("zen-pinned-changed"));
    ok(!mirror.hasAttribute("zen-pinned-changed"));
  } finally {
    await BrowserTestUtils.removeTab(tab);
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_pin_commit_before_workspace_initialization() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gBrowser.pinTab(tab);
  await gZenWindowSync.setPinnedTabState(tab);
  const originalPromise = gZenWorkspaces.promiseInitialized;
  const originalResolve = gZenWorkspaces._resolvePinnedInitialized;
  const initialized = Promise.withResolvers();
  const manager = new gZenPinnedTabManager.constructor();
  manager._initClosePinnedTabShortcut = () => {};
  manager._insertItemsIntoTabContextMenu = () => {};
  gZenWorkspaces.promiseInitialized = initialized.promise;
  gZenWorkspaces._resolvePinnedInitialized = () => {};
  // Only the newly initialized manager may observe this pre-initialization load.
  gBrowser.removeTabsProgressListener(gZenPinnedTabManager);
  try {
    manager.init();
    tab._zenPinnedInitialState = { entry: { url: "about:blank" } };
    const url = "https://example.com/before-workspace-init";
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
    await loaded;
    Assert.equal(tab._zenPinnedInitialState.entry.url, url,
      "A commit before promiseInitialized resolves establishes the pin URL");
    initialized.resolve();
    await initialized.promise;
    const next = "https://example.org/after-workspace-init";
    const navigated = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, next);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, next);
    await navigated;
    Assert.equal(tab._zenPinnedInitialState.entry.url, url,
      "Later navigation cannot replace the pre-initialization reset target");
  } finally {
    initialized.resolve();
    gZenWorkspaces.promiseInitialized = originalPromise;
    gZenWorkspaces._resolvePinnedInitialized = originalResolve;
    gBrowser.removeTabsProgressListener(manager);
    gBrowser.addTabsProgressListener(gZenPinnedTabManager);
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_pending_restored_pin_reconciles_before_startup_reset() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["zen.window-sync.enabled", false],
    ["zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url", true],
    ["browser.sessionstore.restore_on_demand", true],
    ["browser.sessionstore.restore_pinned_tabs_on_demand", true],
  ] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  const originalPromise = win.gZenWorkspaces.promiseInitialized;
  const originalResolve = win.gZenWorkspaces._resolvePinnedInitialized;
  const initialized = Promise.withResolvers();
  const manager = new win.gZenPinnedTabManager.constructor();
  manager._initClosePinnedTabShortcut = () => {};
  manager._insertItemsIntoTabContextMenu = () => {};
  try {
    const url = "https://example.com/pending-restored-pin";
    const state = SessionStore.getWindowState(win);
    state.windows[0].tabs = [
      { entries: [{ url: "about:blank" }], index: 1 },
      { entries: [{ url }], index: 1, pinned: true,
        zenSyncId: "zen-pending-blank-pin",
        zenWorkspace: win.gZenWorkspaces.activeWorkspace,
        _zenPinnedInitialState: { entry: { url: "about:blank" } } },
    ];
    state.windows[0].selected = 1;
    const ready = BrowserTestUtils.waitForEvent(win, "SSWindowStateReady");
    SessionStore.setWindowState(win, state, true);
    await ready;
    const tab = win.document.getElementById("zen-pending-blank-pin");
    ok(tab.hasAttribute("pending"), "SessionStore creates a genuinely pending pin");
    // Emulate legacy data surviving the TabPinned event, as on cold startup.
    tab._zenPinnedInitialState = { entry: { url: "about:blank" } };
    win.gZenWorkspaces.promiseInitialized = initialized.promise;
    win.gZenWorkspaces._resolvePinnedInitialized = () => {};
    manager.init();
    initialized.resolve();
    await TestUtils.waitForCondition(
      () => tab._zenPinnedInitialState.entry.url === url,
      "Startup reconciliation reads the pending restored history");
    Assert.equal(JSON.parse(SessionStore.getTabState(tab)).entries[0].url, url,
      "Startup reset preserves the real pending session entry");
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
    win.gBrowser.selectedTab = tab;
    await loaded;
    Assert.equal(tab._zenPinnedInitialState.entry.url, url);
    Assert.equal(tab.linkedBrowser.currentURI.spec, url);
  } finally {
    initialized.resolve();
    win.gZenWorkspaces.promiseInitialized = originalPromise;
    win.gZenWorkspaces._resolvePinnedInitialized = originalResolve;
    win.gBrowser.removeTabsProgressListener(manager);
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
