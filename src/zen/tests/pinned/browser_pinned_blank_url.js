/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

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
