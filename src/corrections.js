// Shared dictionary corrections. No search data, Tampermonkey API or stylesheet.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KotobankRussianCorrections = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ROOT_SELECTOR = 'article:is(.prj,.pjr) section.description';
  const TARGET_SELECTOR = '[data-orgtag="meaning"], [data-orgtag="example"], [data-orgtag="subheadword"]';
  const USAGE_LABELS = new Set('単 複 男 女 中 述語 無人称 挿入 長尾 短尾 受現 受過 能現 能過 完 不完 話 俗 隠 卑 粗 文 雅 旧 公 詩 民話 幼児 若者 戯 罵 蔑 皮肉 商標'.split(' '));

  function fixText(text) {
    return text
      // 先に重複頭文字を落とす。Е́//Е́сть の結合アクセントも含む。
      // 接頭辞 рас//плавить や単語内部の文字は落とさない。
      .replace(/(^|[^\p{L}\p{M}])([А-ЯЁ])[\u0300\u0301]*(?:\/\/|‐)(?=\2)/gu, '$1')
      .replace(/(?<!:)\/\/(?=[А-Яа-яЁё])/gu, '')
      // U+2010のみ。単語内部のハイフン、ASCIIの略記、5‐20は保存する。
      .replace(/(^|[^\p{L}\p{M}\p{Nd}_-])‐(?=[А-Яа-яЁё])/gu, '$1')
      // ラベル内の斜体などでテキストノードが分かれていても補正する。
      .replace(/\(\(/g, '｟').replace(/\)\)/g, '｠')
      .replace(/〚/g, '〘').replace(/〛/g, '〙')
      .replace(/《([^《》\r\n]+)》/g, (whole, label) =>
        label.split('・').every(part => USAGE_LABELS.has(part)) ? `｟${label}｠` : whole);
  }

  function createController(doc, options = {}) {
    const originals = new Map();
    const observers = [];
    const decorations = new Map();
    const columnWrappers = new Set();
    let enabled = true;
    let applying = false;
    let pendingUpdate;

    function write(node, value) {
      const current = node.nodeValue;
      if (current === value) return;
      const previous = originals.get(node);
      // サイトが後から更新した文字は、新しい原文として保持する。
      originals.set(node, {
        original: previous && current === previous.corrected ? previous.original : current,
        corrected: value,
      });
      node.nodeValue = value;
    }

    function removeBoxes() {
      for (const wrapper of columnWrappers) {
        if (wrapper.parentNode) wrapper.replaceWith(...wrapper.childNodes);
      }
      columnWrappers.clear();
      for (const [node, record] of decorations) {
        if (!node.parentNode) continue;
        // サイトが元のノードを置き換えた場合、旧装飾の末尾を連結しない。
        const text = node.nodeValue !== record.prefix ? node.nodeValue : node.nodeValue + record.parts.map(part => part.nodeType === 3
          ? part.nodeValue : part.hasAttribute('data-ruja-box') ? `[${part.textContent}]` : part.textContent).join('');
        if (text !== record.text) originals.delete(node); // サイト側の更新を新しい原文にする。
        for (const part of record.parts) part.remove();
        node.nodeValue = text;
      }
      decorations.clear();
    }

    function applyBoxes(roots, italicHints) {
      for (const root of roots) {
        const firstMeaning = root.querySelector('[data-orgtag="meaning"]');
        for (const element of root.querySelectorAll(TARGET_SELECTOR)) {
          const walker = doc.createTreeWalker(element, 4);
          const nodes = [];
          let node;
          while ((node = walker.nextNode())) {
            if (!node.parentElement?.closest('[data-ruja-box], script, style, textarea')) nodes.push(node);
          }
          for (const node of nodes) {
            const text = node.nodeValue;
            const boxes = [...text.matchAll(/\[(主|生|与|対|造|前|不定形|命令形|比較級|従属節)\]/g)].filter(match => {
              if (root.closest('article.pjr') || match[1] !== '前') return true;
              const range = doc.createRange();
              range.selectNodeContents(element);
              range.setEnd(node, match.index);
              const before = range.toString();
              // 山括弧内は格指定。用例でも山括弧の外に格指定が現れる。
              if (before.lastIndexOf('〈') > before.lastIndexOf('〉')) return true;
              if (!element.matches('[data-orgtag="meaning"]')) return true;
              // 品詞の区分は、最初の語義以外にもⅡ[前]などとして現れる。
              if (!before.trim() || /[Ⅰ-Ⅿ]\s*$/u.test(before)) return false;
              if (element !== firstMeaning) return true;
              // 本文冒頭の発音・英訳注記に続く品詞表示も除外する。
              // ロシア語に続くо [前]などは格指定として残す。
              if (/[\p{Script=Cyrillic}]/u.test(before)) return true;
              const offset = before.length;
              const first = element.textContent.indexOf('[前]');
              const body = element.textContent.search(/[①-⑳〈]/);
              return offset !== first || (body >= 0 && offset > body);
            }).map(match => ({ index:match.index, length:match[0].length, label:match[1], kind:'box' }));
            const matches = [...boxes, ...(italicHints.get(node) || [])].sort((a,b)=>a.index-b.index);
            if (!matches.length) continue;
            const parts = [];
            let end = matches[0].index;
            node.nodeValue = text.slice(0, end);
            for (const match of matches) {
              if (match.index > end) parts.push(doc.createTextNode(text.slice(end, match.index)));
              const box = doc.createElement('span');
              box.setAttribute(match.kind === 'box' ? 'data-ruja-box' : 'data-ruja-italic', '');
              box.textContent = match.kind === 'box' ? match.label : text.slice(match.index, match.index + match.length);
              if (match.kind === 'box') {
                const label = doc.createElement('span');
                label.textContent = box.textContent;
                box.replaceChildren(label);
              }
              parts.push(box);
              end = match.index + match.length;
            }
            if (end < text.length) parts.push(doc.createTextNode(text.slice(end)));
            const fragment = doc.createDocumentFragment();
            fragment.append(...parts);
            node.after(fragment);
            decorations.set(node, { text, parts, prefix:node.nodeValue });
          }
        }
      }
      for (const root of roots) {
        for (const box of root.querySelectorAll('.white-square')) {
          const label = doc.createElement('span');
          label.setAttribute('data-ruja-column-label', '');
          label.append(...box.childNodes);
          box.append(label);
          columnWrappers.add(label);
        }
      }

    }

    function applyHeadingCorrections(roots) {
      for (const root of roots) {
        const heading = root.parentElement?.querySelector(':scope > h3');
        const meaning = root.querySelector('[data-orgtag="meaning"]');
        if (!heading || !meaning) continue;
        const walker = doc.createTreeWalker(heading, 4);
        const nodes = [];
        let node, offset = 0;
        while ((node = walker.nextNode())) {
          const record = originals.get(node);
          const source = record && node.nodeValue === record.corrected ? record.original : node.nodeValue;
          nodes.push({ node, source, offset });
          offset += source.length;
        }
        const text = nodes.map(item => item.source).join('');
        // 見出し末尾の発音表記だけを調べる。下線・肩番号等の要素は動かさない。
        const suffix = /(?:\s*\[[^\[\]\r\n]*\])+\s*$/.exec(text);
        const labels = new Set([...meaning.textContent.matchAll(/\[[^\[\]]*\]/g)].map(match => fixText(match[0])));
        const ranges = suffix ? [...suffix[0].matchAll(/\s*(\[[^\[\]\r\n]*\])/g)]
          .filter(match => labels.has(fixText(match[1])))
          .map(match => ({ start:suffix.index + match.index, end:suffix.index + match.index + match[0].length })) : [];
        if (ranges.length && text.slice(ranges[ranges.length-1].end).trim() === '') {
          ranges[ranges.length-1].end = text.length;
        }
        for (const item of nodes) {
          let value = '', cursor = 0;
          for (const range of ranges) {
            const start = Math.max(0, range.start - item.offset);
            const end = Math.min(item.source.length, range.end - item.offset);
            if (start >= end) continue;
            value += item.source.slice(cursor, start);
            cursor = end;
          }
          value += item.source.slice(cursor);
          write(item.node, value);
        }
      }
    }

    function apply() {
      if (!enabled || applying) return;
      applying = true;
      try {
        removeBoxes();
        const roots = [...doc.querySelectorAll(ROOT_SELECTOR)];
        const russianRoots = roots.filter(root => root.closest('article.prj'));
        applyHeadingCorrections(russianRoots);
        const italicHints = new Map();
        for (const root of roots) {
          for (const element of root.querySelectorAll(TARGET_SELECTOR)) {
            const walker = doc.createTreeWalker(element, 4);
            let node;
            while ((node = walker.nextNode())) {
              if (node.parentElement?.closest('script, style, textarea')) continue;
              const record = originals.get(node);
              const source = record && node.nodeValue === record.corrected ? record.original : node.nodeValue;
              if (root.closest('article.prj') && element.matches('[data-orgtag="example"]') && !node.parentElement.closest('i, em')) {
                const hints = [...source.matchAll(/[\p{Script=Cyrillic}\p{M}]*(?:\/\/|‐)[\p{Script=Cyrillic}\p{M}]+(?:-[\p{Script=Cyrillic}\p{M}]+)*/gu)]
                  .filter(match => source[match.index-1] !== ':' && fixText(match[0]) !== match[0])
                  .map(match => ({ index:fixText(source.slice(0,match.index)).length, length:fixText(match[0]).length, kind:'italic' }));
                if (hints.length) italicHints.set(node,hints);
              }
              let corrected = fixText(node.nodeValue);
              if (root.closest('article.pjr') && element.matches('[data-orgtag="meaning"][no]')) {
                // 同音異義語の番号付き表記と訳語の境界だけに空白を入れる。
                corrected = corrected.replace(/^([①-⑳][一-龯々ぁ-ゖァ-ヶー・]+)(?=[А-Яа-яЁё])/u, '$1\u2003');
              }
              // 用例の言語間の記号を、一文字分の空白に置き換える。
              const separator = root.closest('article.pjr') ? /‖/g : /｜/g;
              write(node, element.matches('[data-orgtag="example"]') ? corrected.replace(separator, '\u2003') : corrected);
            }
          }
        }
        applyBoxes(roots, italicHints);
        if (roots.length) options.onApply?.();
      } finally {
        // 自分の補正によるMutationObserverの再発火を抑える。
        for (const observer of observers) observer.takeRecords();
        applying = false;
      }
    }

    function restore() {
      if (pendingUpdate !== undefined) { clearTimeout(pendingUpdate); pendingUpdate = undefined; }
      removeBoxes();
      options.onRestore?.();
      for (const [node, record] of originals) {
        // サイト側がさらに変更したテキストを上書きしない。
        if (node.nodeValue === record.corrected) node.nodeValue = record.original;
      }
      originals.clear();
      for (const observer of observers) observer.takeRecords();
    }

    function setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) apply();
      else restore();
    }

    function observe() {
      if (observers.length || typeof MutationObserver !== 'function') return;
      for (const root of doc.querySelectorAll(ROOT_SELECTOR)) {
        const observer = new MutationObserver(records => {
          if (!enabled || pendingUpdate !== undefined) return;
          const relevant = records.some(record => {
            const element = record.target.nodeType === 3 ? record.target.parentElement : record.target;
            return element?.closest(TARGET_SELECTOR) || [...record.addedNodes].some(node =>
              node.nodeType === 1 && (node.matches(TARGET_SELECTOR) || node.querySelector(TARGET_SELECTOR)));
          });
          if (relevant) pendingUpdate = setTimeout(() => { pendingUpdate = undefined; apply(); },40);
        });
        observer.observe(root, { subtree: true, childList: true, characterData: true });
        observers.push(observer);
      }
    }

    return { apply, restore, setEnabled, observe,
      disconnect: () => { for (const o of observers) o.disconnect(); observers.length = 0;
        if (pendingUpdate !== undefined) clearTimeout(pendingUpdate); pendingUpdate = undefined; },
      isEnabled: () => enabled };
  }

  return { fixText, createController };
});
