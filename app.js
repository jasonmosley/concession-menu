/* Concession Menu — a tap-to-order POS.
   Everything on screen comes from menu.json; no code changes needed to edit the menu. */

(function () {
  'use strict';

  var BUILD = 'v3';       // shown on the Sales screen so you can tell what's running
  var MENU = null;
  var cart = [];          // { key, itemId, name, sub, unit, qty }
  var activeCat = null;
  var tendered = 0;
  var tenderFresh = false;   // true right after a quick-cash tap: the next digit starts over
  var SALES_KEY = 'concession.sales.v1';
  var MENU_CACHE_KEY = 'concession.menu.v1';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- money (all math in whole cents) ---------- */
  function toCents(dollars) { return Math.round(Number(dollars || 0) * 100); }
  function money(cents) {
    return (cents < 0 ? '-$' : '$') + (Math.abs(cents) / 100).toFixed(2);
  }

  var DENOMS = [
    [2000, '$20 bill', '$20 bills'],
    [1000, '$10 bill', '$10 bills'],
    [500, '$5 bill', '$5 bills'],
    [100, '$1 bill', '$1 bills'],
    [25, 'quarter', 'quarters'],
    [10, 'dime', 'dimes'],
    [5, 'nickel', 'nickels'],
    [1, 'penny', 'pennies']
  ];

  function changeBreakdown(cents) {
    var parts = [];
    DENOMS.forEach(function (d) {
      var n = Math.floor(cents / d[0]);
      if (!n) return;
      cents -= n * d[0];
      parts.push(n + ' × ' + (n === 1 ? d[1] : d[2]));
    });
    return parts.join(', ');
  }

  /* ---------- screens ---------- */
  function openScreen(id) {
    var el = $(id);
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }
  function closeScreen(id) {
    var el = $(id);
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }
  function isWide() { return window.matchMedia('(min-width: 820px)').matches; }

  /* ---------- menu loading ---------- */
  function loadMenu() {
    fetch('menu.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        try { localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(data)); } catch (e) {}
        start(data);
      })
      .catch(function (err) {
        var cached = null;
        try { cached = JSON.parse(localStorage.getItem(MENU_CACHE_KEY) || 'null'); } catch (e) {}
        if (cached) { start(cached); return; }
        $('loadHint').textContent =
          'Opening the file directly blocks menu.json (' + err.message + '). ' +
          'Serve the folder over http — "python3 -m http.server 8000" — or pick menu.json below to load it once.';
        $('loadSheet').hidden = false;
      });
  }

  $('menuFile').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result);
        try { localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(data)); } catch (err) {}
        $('loadSheet').hidden = true;
        start(data);
      } catch (err) {
        $('loadHint').textContent = 'That file is not valid JSON: ' + err.message;
      }
    };
    fr.readAsText(f);
  });

  function start(data) {
    MENU = data;
    document.title = (data.standName || 'Concession') + ' — Order';
    $('standName').textContent = data.standName || 'Concession Stand';
    $('standSub').textContent = data.subtitle || '';
    activeCat = (data.categories && data.categories[0]) ? data.categories[0].id : null;
    renderTabs();
    renderGrid();
    renderCart();
    renderQuickCash();
    if (isWide()) openScreen('orderScreen');
  }

  /* ---------- menu rendering ---------- */
  function renderTabs() {
    var el = $('tabs');
    el.innerHTML = '';
    MENU.categories.forEach(function (cat) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (cat.id === activeCat ? ' active' : '');
      b.textContent = cat.name;
      b.onclick = function () {
        activeCat = cat.id;
        renderTabs();
        renderGrid();
        $('grid').scrollTop = 0;
      };
      el.appendChild(b);
    });
  }

  function countInCart(itemId) {
    return cart.reduce(function (n, l) { return n + (l.itemId === itemId ? l.qty : 0); }, 0);
  }

  function renderGrid() {
    var cat = MENU.categories.filter(function (c) { return c.id === activeCat; })[0];
    var el = $('grid');
    el.innerHTML = '';
    if (!cat) return;
    cat.items.forEach(function (item) {
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'tile';

      var em = document.createElement('span');
      em.className = 'emoji';
      em.textContent = item.emoji || '🍽️';
      var nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = item.name;
      var pr = document.createElement('span');
      pr.className = 'price';
      pr.textContent = item.openPrice ? 'as marked' : money(toCents(item.price));
      t.appendChild(em); t.appendChild(nm); t.appendChild(pr);

      if (item.note) {
        var nt = document.createElement('span');
        nt.className = 'note';
        nt.textContent = item.note;
        t.appendChild(nt);
      }
      var n = countInCart(item.id);
      if (n) {
        var b = document.createElement('span');
        b.className = 'badge';
        b.textContent = n;
        t.appendChild(b);
      }
      t.onclick = function () { tapItem(item); };
      el.appendChild(t);
    });
  }

  /* ---------- adding to the order ---------- */
  function tapItem(item) {
    if (item.options && item.options.length) { askOption(item); return; }
    if (item.openPrice) { askPrice(item); return; }
    addLine(item, null, toCents(item.price));
  }

  function askOption(item) {
    var grid = $('optionGrid');
    $('optionTitle').textContent = item.name;
    grid.innerHTML = '';
    item.options.forEach(function (opt) {
      var name = typeof opt === 'string' ? opt : opt.name;
      var cents = (typeof opt === 'string' || opt.price == null)
        ? toCents(item.price) : toCents(opt.price);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = name;
      b.onclick = function () {
        $('optionSheet').hidden = true;
        if (item.openPrice) askPrice(item, name);
        else addLine(item, name, cents);
      };
      grid.appendChild(b);
    });
    $('optionSheet').hidden = false;
  }

  var priceEntry = { cents: 0, item: null, sub: null };

  function askPrice(item, sub) {
    priceEntry = { cents: 0, item: item, sub: sub || null };
    $('priceTitle').textContent = 'Price for ' + item.name;
    $('priceDisplay').textContent = money(0);
    $('priceSheet').hidden = false;
  }

  function addLine(item, sub, unitCents) {
    var key = item.id + '|' + (sub || '') + '|' + unitCents;
    var found = cart.filter(function (l) { return l.key === key; })[0];
    if (found) found.qty += 1;
    else cart.push({ key: key, itemId: item.id, name: item.name, sub: sub, unit: unitCents, qty: 1 });
    renderCart();
    renderGrid();
    buzz();
  }

  function buzz() {
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
  }

  /* ---------- totals ---------- */
  function subtotalCents() { return cart.reduce(function (s, l) { return s + l.unit * l.qty; }, 0); }
  function taxCents() {
    var rate = Number((MENU && MENU.taxRate) || 0);
    return rate > 0 ? Math.round(subtotalCents() * rate) : 0;
  }
  function totalCents() { return subtotalCents() + taxCents(); }
  function itemCount() { return cart.reduce(function (s, l) { return s + l.qty; }, 0); }
  function plural(n) { return n + (n === 1 ? ' item' : ' items'); }

  function totalsInto(target) {
    target.innerHTML = '';
    function row(label, value, cls) {
      var d = document.createElement('div');
      d.className = 'row' + (cls ? ' ' + cls : '');
      var a = document.createElement('span'); a.textContent = label;
      var b = document.createElement('span'); b.textContent = value;
      d.appendChild(a); d.appendChild(b);
      target.appendChild(d);
    }
    if (taxCents() > 0) {
      row('Subtotal', money(subtotalCents()));
      row('Tax', money(taxCents()));
    }
    row('Total', money(totalCents()), 'grand');
  }

  /* ---------- order lines ---------- */
  function changeQty(line, delta) {
    line.qty += delta;
    if (line.qty <= 0) cart = cart.filter(function (l) { return l !== line; });
    renderCart();
    renderGrid();
    if (!cart.length && !isWide()) closeScreen('orderScreen');
  }

  function renderCart() {
    var ul = $('lines');
    ul.innerHTML = '';

    if (!cart.length) {
      var p = document.createElement('li');
      p.className = 'empty';
      p.textContent = 'Tap items to build the order.';
      ul.appendChild(p);
    } else {
      cart.forEach(function (line) {
        var li = document.createElement('li');
        li.className = 'line';

        var name = document.createElement('div');
        name.className = 'line-name';
        name.textContent = line.name;
        if (line.sub) {
          var sub = document.createElement('div');
          sub.className = 'line-sub';
          sub.textContent = line.sub;
          name.appendChild(sub);
        }
        var each = document.createElement('div');
        each.className = 'line-sub';
        each.textContent = money(line.unit) + ' each';
        name.appendChild(each);

        var tot = document.createElement('div');
        tot.className = 'line-total';
        tot.textContent = money(line.unit * line.qty);

        var qty = document.createElement('div');
        qty.className = 'qty';
        var minus = document.createElement('button');
        minus.type = 'button'; minus.textContent = '−';
        minus.setAttribute('aria-label', 'One less ' + line.name);
        minus.onclick = function () { changeQty(line, -1); };
        var n = document.createElement('span');
        n.className = 'n'; n.textContent = line.qty;
        var plus = document.createElement('button');
        plus.type = 'button'; plus.textContent = '+';
        plus.setAttribute('aria-label', 'One more ' + line.name);
        plus.onclick = function () { changeQty(line, 1); };
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'rm'; rm.textContent = 'Remove';
        rm.onclick = function () { changeQty(line, -line.qty); };
        qty.appendChild(minus); qty.appendChild(n); qty.appendChild(plus); qty.appendChild(rm);

        li.appendChild(name); li.appendChild(tot); li.appendChild(qty);
        ul.appendChild(li);
      });
    }

    totalsInto($('orderTotals'));
    $('btnCheckout').disabled = cart.length === 0;

    $('dockCount').textContent = cart.length ? plural(itemCount()) : 'No items yet';
    $('dockTotal').textContent = money(totalCents());
    $('btnReview').disabled = cart.length === 0;
  }

  /* ---------- keypads ---------- */
  function buildKeypad(el, onKey) {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];
    el.innerHTML = '';
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = k;
      b.onclick = function () { onKey(k); buzz(); };
      el.appendChild(b);
    });
  }

  function applyKey(cents, key) {
    if (key === '⌫') return Math.floor(cents / 10);
    var next = key === '00' ? cents * 100 : cents * 10 + Number(key);
    return Math.min(next, 99999999);
  }

  buildKeypad($('priceKeypad'), function (k) {
    priceEntry.cents = applyKey(priceEntry.cents, k);
    $('priceDisplay').textContent = money(priceEntry.cents);
  });

  $('priceAdd').onclick = function () {
    if (priceEntry.cents <= 0) return;
    $('priceSheet').hidden = true;
    addLine(priceEntry.item, priceEntry.sub, priceEntry.cents);
  };

  buildKeypad($('cashKeypad'), function (k) {
    // After tapping "$20", punching a digit means "actually, they gave me this
    // instead" — not "append to twenty".
    if (tenderFresh && k !== '⌫') tendered = 0;
    tenderFresh = false;
    tendered = applyKey(tendered, k);
    renderChange();
  });

  /* ---------- checkout ---------- */
  function renderQuickCash() {
    var el = $('quickCash');
    el.innerHTML = '';
    function add(label, onTap) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.onclick = function () { onTap(); tenderFresh = true; renderChange(); buzz(); };
      el.appendChild(b);
    }
    add('Exact', function () { tendered = totalCents(); });
    // Bills stack up: two twenties is just $20 tapped twice.
    ((MENU && MENU.quickCash) || [5, 10, 20, 50]).forEach(function (v) {
      add('$' + v, function () { tendered = Math.min(tendered + toCents(v), 99999999); });
    });
  }

  function renderChange() {
    $('tenderDisplay').textContent = money(tendered);
    $('btnClearCash').hidden = tendered === 0;
    var due = totalCents();
    var diff = tendered - due;
    var box = $('changeBox');
    box.classList.remove('ok', 'short');
    if (tendered === 0) {
      $('changeAmount').textContent = money(0);
      $('changeBreak').textContent = '';
    } else if (diff < 0) {
      box.classList.add('short');
      $('changeAmount').textContent = money(-diff);
      $('changeBreak').textContent = 'still owed';
    } else {
      box.classList.add('ok');
      $('changeAmount').textContent = money(diff);
      $('changeBreak').textContent = diff > 0 ? changeBreakdown(diff) : 'exact change';
    }
    $('btnComplete').disabled = tendered < due;
  }

  function openCheckout() {
    if (!cart.length) return;
    tendered = 0;
    tenderFresh = false;
    $('dueAmount').textContent = money(totalCents());
    renderQuickCash();
    renderChange();
    $('checkoutScreen').querySelector('.checkout-body').scrollTop = 0;
    openScreen('checkoutScreen');
  }

  $('btnClearCash').onclick = function () {
    tendered = 0;
    tenderFresh = false;
    renderChange();
    buzz();
  };

  $('btnReview').onclick = function () { openScreen('orderScreen'); };
  $('btnCloseOrder').onclick = function () { closeScreen('orderScreen'); };
  $('btnCheckout').onclick = openCheckout;
  $('btnBackCheckout').onclick = function () { closeScreen('checkoutScreen'); };
  $('btnViewItems').onclick = function () {
    closeScreen('checkoutScreen');
    openScreen('orderScreen');
  };

  $('btnComplete').onclick = function () {
    var due = totalCents();
    var sale = {
      t: Date.now(),
      total: due,
      tendered: tendered,
      change: tendered - due,
      lines: cart.map(function (l) {
        return { name: l.name, sub: l.sub, unit: l.unit, qty: l.qty };
      })
    };
    var sales = readSales();
    sales.push(sale);
    try { localStorage.setItem(SALES_KEY, JSON.stringify(sales)); } catch (e) {}

    closeScreen('checkoutScreen');
    if (!isWide()) closeScreen('orderScreen');
    showToast(sale.change > 0
      ? 'Give ' + money(sale.change) + ' change'
      : 'Sale complete — exact change');
    cart = [];
    tendered = 0;
    tenderFresh = false;
    renderCart();
    renderGrid();
    buzz();
  };

  /* ---------- sales report ---------- */
  function readSales() {
    try { return JSON.parse(localStorage.getItem(SALES_KEY) || '[]'); }
    catch (e) { return []; }
  }

  $('btnSales').onclick = function () {
    var sales = readSales();
    var gross = sales.reduce(function (s, x) { return s + x.total; }, 0);
    var counts = {};
    sales.forEach(function (s) {
      s.lines.forEach(function (l) {
        var key = l.name + (l.sub ? ' — ' + l.sub : '');
        counts[key] = (counts[key] || 0) + l.qty;
      });
    });

    var body = $('reportBody');
    body.innerHTML = '';
    function stat(label, value, cls) {
      var d = document.createElement('div');
      d.className = 'stat-row' + (cls ? ' ' + cls : '');
      var a = document.createElement('span'); a.textContent = label;
      var b = document.createElement('strong'); b.textContent = value;
      d.appendChild(a); d.appendChild(b);
      body.appendChild(d);
    }
    stat('Orders', String(sales.length));
    stat('Cash taken in', money(gross), 'grand');

    var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (names.length) {
      var table = document.createElement('table');
      names.forEach(function (n) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.textContent = n;
        var td2 = document.createElement('td'); td2.textContent = counts[n];
        tr.appendChild(td1); tr.appendChild(td2);
        table.appendChild(tr);
      });
      body.appendChild(table);
    }

    var diag = document.createElement('div');
    diag.className = 'diag';
    diag.textContent = diagnostics();
    body.appendChild(diag);

    openScreen('salesScreen');
  };

  // A one-line readout of what this device is actually reporting. Handy when
  // the installed app and the browser disagree about how tall the screen is.
  function diagnostics() {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;' +
      'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var top = Math.round(parseFloat(cs.paddingTop) || 0);
    var bot = Math.round(parseFloat(cs.paddingBottom) || 0);
    document.body.removeChild(probe);

    var shell = Math.round($('grid').closest('.app').getBoundingClientRect().height);
    var mode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone'
             : (navigator.standalone ? 'standalone-ios' : 'browser');
    return BUILD + ' · ' + window.innerWidth + '×' + window.innerHeight +
           ' · shell ' + shell + ' · insets ' + top + '/' + bot + ' · ' + mode;
  }

  $('btnCloseSales').onclick = function () { closeScreen('salesScreen'); };

  $('btnResetSales').onclick = function () {
    if (!confirm('Clear all recorded sales? This cannot be undone.')) return;
    try { localStorage.removeItem(SALES_KEY); } catch (e) {}
    closeScreen('salesScreen');
    showToast('Sales totals reset');
  };

  /* ---------- misc ---------- */
  $('btnClear').onclick = function () {
    if (!cart.length) return;
    if (!confirm('Clear this order?')) return;
    cart = [];
    renderCart();
    renderGrid();
    if (!isWide()) closeScreen('orderScreen');
  };

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.onclick = function () { b.closest('.sheet-wrap').hidden = true; };
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['optionSheet', 'priceSheet'].forEach(function (id) { $(id).hidden = true; });
    closeScreen('salesScreen');
    closeScreen('checkoutScreen');
    if (!isWide()) closeScreen('orderScreen');
  });

  var toastTimer = null;
  function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  window.addEventListener('resize', function () {
    if (isWide()) openScreen('orderScreen');
  });

  if ('serviceWorker' in navigator) {
    // Whether this page was already under a worker's control. On a first-ever
    // visit it isn't, and the install that follows must not trigger a reload.
    var hadWorker = !!navigator.serviceWorker.controller;
    var reloading = false;

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });

    // A new version finished installing. Pick it up now rather than making
    // someone launch the app twice — but never yank the page out from under
    // an order that's half rung up.
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading || !hadWorker || cart.length) return;
      reloading = true;
      window.location.reload();
    });
  }

  loadMenu();
})();
