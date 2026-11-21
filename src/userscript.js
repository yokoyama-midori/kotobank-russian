// ==UserScript==
// @name         コトバンク ロシア語辞典：表示補正・検索サジェスト
// @namespace    https://github.com/yokoyama-midori/kotobank-russian
// @homepageURL  https://github.com/yokoyama-midori/kotobank-russian
// @version      1.0.5
// @description コトバンク ロシア語辞典の表示補正、検索サジェストと単語ページへの直接移動、フォント選択
// @match        https://kotobank.jp/rujaword/*
// @match        https://kotobank.jp/jaruword/*
// @run-at       document-end
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  /* @include corrections */

  const { fixText } = corrections;
  function createController(doc) {
    let style;
    return corrections.createController(doc, {
      onApply() {
        if (style) return;
        style = doc.createElement('style');
        style.textContent = CORRECTION_CSS;
        doc.head.append(style);
      },
      onRestore() {
        style?.remove();
        style = undefined;
      },
    });
  }

  function searchKey(text) {
    // й・ёの区別は保ち、大小文字と主・副アクセントだけを吸収する。
    return text.trim().toLowerCase().normalize('NFD')
      .replace(/[\u0300\u0301]/g, '').normalize('NFC');
  }

  function compositionQuery(text, composing) {
    // IMEの未完成ローマ字だけ検索から除き、入力値や通常の英字検索は変えない。
    return composing ? text.replace(/([ぁ-ゖァ-ヶー])[a-zA-Zａ-ｚＡ-Ｚ]+$/, '$1') : text;
  }

  function japaneseKey(text) {
    return text.trim().toLowerCase().replace(/[ァ-ヶ]/g, character =>
      String.fromCharCode(character.charCodeAt(0) - 0x60));
  }

  function readingVariants(reading) {
    return [...new Set([reading, reading.replace(/（[^）]*）/g, ''), reading.replace(/[（）]/g, '')])];
  }

  function createBilingualIndex(russianWords, japaneseRows) {
    const entries = [];
    for (const word of russianWords) entries.push({key:searchKey(word), word, kind:'露和', href:'https://kotobank.jp/rujaword/'+encodeURIComponent(word)});
    for (const [word, readings, targetWord = word] of japaneseRows) {
      const keys = new Set([japaneseKey(word), ...readings.flatMap(readingVariants).map(japaneseKey)]);
      for (const key of keys) if (key) entries.push({key, word, reading:readings.join('・'), kind:'和露', href:'https://kotobank.jp/jaruword/'+encodeURIComponent(targetWord)});
    }
    entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    return (query, limit=12) => {
      const key = japaneseKey(searchKey(query));
      if (!key) return [];
      let left=0, right=entries.length;
      while (left<right) { const middle=(left+right)>>>1; if(entries[middle].key<key)left=middle+1;else right=middle; }
      const results=[], seen=new Set();
      // 同じ語の検索キーはまとめる。同じURLに収録された別の語は残す。
      while(left<entries.length && entries[left].key.startsWith(key) && results.length<limit){
        const entry=entries[left++], identity=entry.kind+'\u0000'+entry.word+'\u0000'+entry.href;
        if(seen.has(identity))continue;seen.add(identity);results.push(entry);
      }
      return results;
    };
  }

  function installSuggestions(doc, getIndex) {
    const inputs = [...doc.querySelectorAll('form input[name="q"]')].filter(input => {
      const action = new URL(input.form.action, doc.baseURI);
      return action.hostname === 'kotobank.jp' && action.pathname === '/search';
    });
    if (!inputs.length) return;
    let search;
    let serial = 0;
    const closers = [];
    const style = doc.createElement('style');
    style.textContent = `
      /* customSelectの透明な選択欄を、見た目のボタンに重ねる。 */
      #searchAreaWordBottom .selectwrap { position:relative !important; }
      #searchAreaWordBottom .selectwrap select.hasCustomSelect { left:0 !important; top:10px !important; }
      .ruja-suggest { position:fixed !important; z-index:2147483646 !important;
        box-sizing:border-box !important; margin:0 !important; padding:0 !important;
        border:1px solid #ccc !important; border-radius:0 0 7px 7px !important;
        background:#fff !important; color:#222 !important;
        box-shadow:0 5px 14px #0002 !important; text-align:left !important;
        font:16px/1.5 Arial, Meiryo, sans-serif !important; overflow:auto !important; }
      .ruja-suggest[hidden] { display:none !important; }
      .ruja-suggest a.ruja-suggest-option { display:block !important; box-sizing:border-box !important;
        padding:6px 12px !important; margin:0 !important; border:0 !important;
        background:#fff !important; color:#222 !important; text-decoration:none !important;
        font:16px/1.5 Arial,Meiryo,sans-serif !important; cursor:pointer !important; }
      .ruja-suggest a.ruja-suggest-option:hover,
      .ruja-suggest a.ruja-suggest-option[aria-selected="true"] {
        background:#eee !important; color:#222 !important; }
      .ruja-suggest .ruja-suggest-reading { margin-left:10px; font-size:12px; color:#666; }
      .ruja-suggest .ruja-suggest-kind { float:right; margin-left:12px; font-size:12px; color:#666; }
    `;
    doc.head.append(style);
    for (const input of inputs) {
      const panel = doc.createElement('div');
      panel.className = 'ruja-suggest';
      panel.id = 'ruja-suggest-' + (++serial);
      panel.hidden = true;
      const list = doc.createElement('div');
      list.id = panel.id + '-list';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'ロシア語辞典の候補');
      panel.append(list);
      doc.body.append(panel);
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', list.id);
      input.setAttribute('aria-expanded', 'false');
      let composing = false, active = -1, pointerSelection, renderedQuery;
      const select = input.form.querySelector('select[name="t"]');
      const eligible = () => !select || ['rj','jr','all'].includes(select.value);
      function close() {
        if (pointerSelection) return;
        renderedQuery = undefined;
        panel.hidden = true;
        list.children[active]?.setAttribute('aria-selected', 'false');
        active = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
      }
      closers.push(close);
      function position() {
        if (panel.hidden) return;
        const rect = input.getBoundingClientRect();
        if (!rect.width || !rect.height) { close(); return; }
        panel.style.left = Math.max(0, rect.left) + 'px';
        panel.style.top = rect.bottom + 'px';
        panel.style.width = Math.min(rect.width, doc.defaultView.innerWidth - Math.max(0,rect.left)) + 'px';
        panel.style.maxHeight = Math.max(0, Math.min(360, doc.defaultView.innerHeight - rect.bottom - 8)) + 'px';
      }
      function choose(index, automatic = false) {
        const links = [...list.children];
        active = index;
        links.forEach((link,i) => link.setAttribute('aria-selected', String(i === active)));
        input.setAttribute('aria-activedescendant', links[active].id);
        if (!automatic) links[active].scrollIntoView({ block:'nearest' });
      }
      function render(automatic = true) {
        if (pointerSelection) return;
        const query = compositionQuery(input.value, composing);
        if (doc.activeElement !== input || !eligible() || !searchKey(query)) { close(); return; }
        if (!panel.hidden && renderedQuery === query) return;
        // 初めて入力するときにだけ索引を作り、以後は同じ索引を再利用する。
        if (!search) search = getIndex();
        const results = search(query);
        closers.forEach(fn => { if (fn !== close) fn(); });
        if (!results.length) { close(); return; }
        const fragment = doc.createDocumentFragment();
        for (const [i, result] of results.entries()) {
          const link = doc.createElement('a');
          link.className = 'ruja-suggest-option';
          link.id = list.id + '-' + i;
          link.href = result.href;
          link.textContent = result.word;
          if (result.reading && japaneseKey(result.reading) !== japaneseKey(result.word)) {
            const reading = doc.createElement('span');
            reading.className = 'ruja-suggest-reading'; reading.textContent = result.reading; link.append(reading);
          }
          if (result.kind) {
            const kind = doc.createElement('span');
            kind.className = 'ruja-suggest-kind'; kind.textContent = result.kind; link.append(kind);
          }
          link.setAttribute('aria-label', result.word);
          link.setAttribute('role', 'option');
          link.setAttribute('aria-selected', 'false');
          link.tabIndex = -1;
          fragment.append(link);
        }
        // 表示中の一覧を隠さず、一度のDOM更新で最新の候補に置き換える。
        list.replaceChildren(fragment);
        renderedQuery = query;
        active = -1;
        input.removeAttribute('aria-activedescendant');
        panel.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        position();
        if (automatic) choose(0, true);
      }
      function schedule() {
        // 通信を伴わない検索なので、待機せず更新し、古い候補の選択も防ぐ。
        render();
      }
      // IME確定時のinputで、クリック途中の候補を消さない。
      input.addEventListener('input', schedule);
      input.addEventListener('focus', schedule);
      input.addEventListener('blur', close);
      input.addEventListener('compositionstart', () => {
        composing = true; schedule();
      });
      input.addEventListener('compositionupdate', schedule);
      input.addEventListener('compositionend', () => {
        composing = false; schedule();
      });
      input.addEventListener('keydown', event => {
        if (composing || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { close(); return; }
        const tab = event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (tab && !panel.hidden)) {
          if (panel.hidden) render(false);
          if (panel.hidden) return;
          event.preventDefault();
          const links = [...list.children];
          const forward = event.key === 'ArrowDown' || (tab && !event.shiftKey);
          const next = active < 0 ? (forward ? 0 : links.length - 1)
            : (active + (forward ? 1 : -1) + links.length) % links.length;
          choose(next);
        } else if (event.key === 'Enter' && !panel.hidden && active >= 0) {
          event.preventDefault();
          list.children[active].click();
        } else if (event.key === 'Tab') close();
      });
      // 入力欄のblurで候補が消える前に、リンクの通常のクリックを成立させる。
      panel.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
      panel.addEventListener('pointerdown', event => {
        const link = event.target.closest('a.ruja-suggest-option');
        if (event.button !== 0 || !link) return;
        pointerSelection = { link, pointerId:event.pointerId };
      }, true);
      function releasePointer(event) {
        if (!pointerSelection || event.pointerId !== pointerSelection.pointerId) return;
        // pointerup直後のclickと通常のリンク動作が終わってから更新する。
        const selection = pointerSelection;
        setTimeout(() => {
          if (pointerSelection !== selection) return;
          pointerSelection = undefined;
          if (doc.activeElement === input) schedule(); else close();
        }, 0);
      }
      doc.addEventListener('pointerup', releasePointer, true);
      doc.addEventListener('pointercancel', releasePointer, true);
      select?.addEventListener('change', () => { close(); });
      input.form.addEventListener('submit', close);
      doc.defaultView.addEventListener('resize', position);
      doc.addEventListener('scroll', position, true);
    }
  }

  // 同じ実装をオフライン検証でも使用する。
  if (typeof module === 'object' && module.exports) {
    module.exports = { fixText, createController, searchKey, compositionQuery, japaneseKey, readingVariants, createBilingualIndex, installSuggestions };
    return;
  }

  if (location.hostname !== 'kotobank.jp' || !/^\/(?:rujaword|jaruword)\//.test(location.pathname)) return;
  const controller = createController(document);
  const storageKey = 'kotobank-ruja-fix-enabled';
  let menuId;
  function setCorrectionEnabled(value) {
    controller.setEnabled(value);
    if (typeof GM_setValue === 'function') GM_setValue(storageKey, controller.isEnabled());
    updateMenu();
  }
  function updateMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    menuId = GM_registerMenuCommand(
      controller.isEnabled() ? '✓ 表示補正：ON' : '□ 表示補正：OFF',
      () => {
        setCorrectionEnabled(!controller.isEnabled());
      }, { id:menuId, autoClose:false, title:'クリックで表示補正のON/OFFを切り替えます' });
  }
  controller.setEnabled(typeof GM_getValue === 'function' ? GM_getValue(storageKey, true) : true);
  controller.observe();
  updateMenu();

  // フォント上書きは常時ON。言語ごとの書体選択は独立して保存する。
  const jpFonts = document.createElement('link');
  jpFonts.id = 'kotobank-jp-fonts';
  jpFonts.rel = 'stylesheet';
  jpFonts.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@100..900&family=Noto+Serif+JP:wght@200..900&display=swap';
  document.head.append(jpFonts);

  const fontStyle = document.createElement('style');
  document.head.append(fontStyle);
  const jpSerifKey = 'kotobank-ruja-jp-serif';
  const ruSerifKey = 'kotobank-ruja-ru-serif';
  let jpSerif = typeof GM_getValue === 'function' ? Boolean(GM_getValue(jpSerifKey, false)) : false;
  let ruSerif = typeof GM_getValue === 'function' ? Boolean(GM_getValue(ruSerifKey, false)) : false;
  // キリル文字と結合アクセントだけ、ロシア語用の公式TTFを使う。
  const fontFaces = `
@font-face{font-family:"Kotobank Noto Sans";font-style:normal;font-weight:100 900;font-display:swap;src:url("https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf") format("truetype");unicode-range:U+0300-036F, U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F, U+1E030-1E08F;}
@font-face{font-family:"Kotobank Noto Sans";font-style:italic;font-weight:100 900;font-display:swap;src:url("https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans-Italic%5Bwdth,wght%5D.ttf") format("truetype");unicode-range:U+0300-036F, U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F, U+1E030-1E08F;}
@font-face{font-family:"Kotobank Noto Serif";font-style:normal;font-weight:100 900;font-display:swap;src:url("https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif%5Bwdth,wght%5D.ttf") format("truetype");unicode-range:U+0300-036F, U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F, U+1E030-1E08F;}
@font-face{font-family:"Kotobank Noto Serif";font-style:italic;font-weight:100 900;font-display:swap;src:url("https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-Italic%5Bwdth,wght%5D.ttf") format("truetype");unicode-range:U+0300-036F, U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F, U+1E030-1E08F;}
`;
  function applyFont() {
    const ruFamily = ruSerif ? 'Kotobank Noto Serif' : 'Kotobank Noto Sans';
    const jpFamily = jpSerif ? 'Noto Serif JP' : 'Noto Sans JP';
    const fallback = jpSerif ? '"Yu Mincho", serif' : 'Meiryo, sans-serif';
    fontStyle.textContent = `${fontFaces}\n#mainTitle h1, article:is(.prj,.pjr) > h2, article:is(.prj,.pjr) > h2 *, article:is(.prj,.pjr) .ex h3, article:is(.prj,.pjr) .ex h3 *, article:is(.prj,.pjr) section.description, article:is(.prj,.pjr) section.description *, body .ruja-suggest a.ruja-suggest-option, body .ruja-suggest .ruja-suggest-heading { font-family: "${ruFamily}", "${jpFamily}", ${fallback} !important; }`;
  }
  let jpMenuId, ruMenuId;
  function updateFontMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    jpMenuId = GM_registerMenuCommand(jpSerif ? '日本語フォント：明朝体' : '日本語フォント：ゴシック体', () => {
      jpSerif = !jpSerif;
      if (typeof GM_setValue === 'function') GM_setValue(jpSerifKey, jpSerif);
      applyFont();
      updateFontMenus();
    }, { id:jpMenuId, autoClose:false, title:'クリックでNoto Sans JP／Noto Serif JPを切り替えます（括弧・数字・欧文も共通）' });
    ruMenuId = GM_registerMenuCommand(ruSerif ? 'ロシア語フォント：セリフ体' : 'ロシア語フォント：サンセリフ体', () => {
      ruSerif = !ruSerif;
      if (typeof GM_setValue === 'function') GM_setValue(ruSerifKey, ruSerif);
      applyFont();
      updateFontMenus();
    }, { id:ruMenuId, autoClose:false, title:'クリックでNoto Sans／Noto Serifを切り替えます（通常体・斜体・太字）' });
  }
  applyFont();
  updateFontMenus();
  /* @include search-data */
})();
