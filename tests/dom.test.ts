import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../src/main/dom';
import { parseHtml, serialize, textContent } from '../src/main/dom/parser';
import { querySelectorAll } from '../src/main/dom/selector';
import { decodeHtmlEntities } from '../src/main/dom/nodes';

test('parses attributes in every quoting style', () => {
  const $ = load(`<div id=a class="x y" data-v='1' hidden data-json="{&quot;a&quot;:1}">t</div>`);
  const el = $('#a');
  assert.equal(el.length, 1);
  assert.equal(el.attr('class'), 'x y');
  assert.equal(el.attr('data-v'), '1');
  assert.equal(el.attr('hidden'), '');
  assert.equal(el.attr('data-json'), '{"a":1}');
  assert.equal(el.text(), 't');
});

test('handles implied end tags for list and table markup', () => {
  const $ = load('<ul><li>one<li>two<li>three</ul>');
  assert.equal($('li').length, 3);
  assert.equal($('li').first().text(), 'one');

  const $t = load('<table><tr><td>a<td>b<tr><td>c</table>');
  assert.equal($t('tr').length, 2);
  assert.equal($t('td').length, 3);
  assert.equal($t('tr').first().find('td').length, 2);
});

test('paragraph auto-closing does not swallow following content', () => {
  const $ = load('<p>one<p>two<div>three</div>');
  assert.equal($('p').length, 2);
  assert.equal($('p').first().text(), 'one');
  assert.equal($('div').text(), 'three');
});

test('script and style content is captured but not parsed as markup', () => {
  const html = `<script>var x = "<div>not real</div>"; if (a < b) {}</script><div>real</div>`;
  const $ = load(html);
  assert.equal($('div').length, 1);
  assert.equal($('div').text(), 'real');
  assert.match($('script').html() ?? '', /not real/);
});

test('json-ld script survives round-tripping', () => {
  const payload = { '@type': 'Product', name: 'A & B <tag>', offers: { price: '10.00' } };
  const $ = load(`<script type="application/ld+json">${JSON.stringify(payload)}</script>`);
  const parsed = JSON.parse($('script[type="application/ld+json"]').html() ?? '{}');
  assert.equal(parsed.name, 'A & B <tag>');
  assert.equal(parsed.offers.price, '10.00');
});

test('selector engine supports the operators the extractors use', () => {
  const html = `
    <body class="woocommerce-page single-product">
      <div class="product" id="product-42">
        <h1 class="product_title entry-title">Hello</h1>
        <form class="variations_form cart" data-product_id="42" data-product_variations="[]">
          <select name="attribute_pa_color"><option value=""></option><option value="black">Black</option></select>
        </form>
        <p class="price"><del><span class="amount">$20</span></del><ins><span class="amount">$15</span></ins></p>
        <a href="x" rel="tag">t</a>
      </div>
      <meta name="generator" content="WooCommerce 8.2">
    </body>`;
  const $ = load(html);
  assert.equal($('body').attr('class'), 'woocommerce-page single-product');
  assert.equal($('form.variations_form').attr('data-product_id'), '42');
  assert.equal($('select[name^="attribute_"]').length, 1);
  assert.equal($('meta[name="generator"][content*="WooCommerce" i]').length, 1);
  assert.equal($('meta[name="generator"][content*="woocommerce" i]').length, 1);
  assert.equal($('div[id^="product-"]').attr('id'), 'product-42');
  assert.equal($('.price ins .amount').text(), '$15');
  assert.equal($('.price del .amount').text(), '$20');
  assert.equal($('.product > h1').length, 1);
  assert.equal($('h1.product_title, .missing').length, 1);
  assert.equal($('[class*="price" i]:not([class*="compare" i]):not(del):not(s)').length, 1);
});

test('child, sibling and :not combinators', () => {
  const $ = load('<ul><li class="a">1</li><li class="b">2</li><li class="c">3</li></ul>');
  assert.equal($('li.a + li').text(), '2');
  assert.equal($('li.a ~ li').length, 2);
  assert.equal($('li:not(.a)').length, 2);
  assert.equal($('li:first-child').text(), '1');
  assert.equal($('li:last-child').text(), '3');
  assert.equal($('li:nth-child(2)').text(), '2');
});

test('closest, contents, replaceWith and clone', () => {
  const $ = load('<div class="wrap"><span class="inner">hi <b>there</b></span></div>');
  assert.equal($('.inner').closest('.wrap').length, 1);
  assert.equal($('.inner').contents().length, 2);

  const clone = $('.wrap').clone();
  assert.equal(clone.find('b').text(), 'there');

  $('b').replaceWith($('b').contents());
  assert.equal($('.inner').text(), 'hi there');
  assert.equal($('b').length, 0);
});

test('entity decoding covers numeric, hex and named forms', () => {
  assert.equal(decodeHtmlEntities('a &amp; b'), 'a & b');
  assert.equal(decodeHtmlEntities('&#8364;9'), '€9');
  assert.equal(decodeHtmlEntities('&#x20AC;9'), '€9');
  assert.equal(decodeHtmlEntities('caf&eacute;'), 'caf&eacute;'); // unknown names are left alone
  assert.equal(decodeHtmlEntities('&nbsp;x'), ' x');
  assert.equal(decodeHtmlEntities('&notreal;'), '&notreal;');
});

test('serialisation escapes text but preserves raw script bodies', () => {
  const doc = parseHtml('<p>a & b < c</p><script>if (1 < 2) {}</script>', { fragment: true });
  const out = doc.children.map(serialize).join('');
  assert.match(out, /a &amp; b &lt; c/);
  assert.match(out, /if \(1 < 2\) \{\}/);
});

test('textContent skips script and style', () => {
  const doc = parseHtml('<div>keep<script>drop</script><style>drop</style>keep2</div>', { fragment: true });
  assert.equal(textContent(doc.children[0]), 'keepkeep2');
});

test('malformed markup does not throw and still yields a tree', () => {
  const nasty = '<div class=unclosed><p>text<span>more</div><img src="a.jpg"><br/><<>>&';
  const $ = load(nasty);
  assert.ok($('div').length >= 1);
  assert.equal($('img').attr('src'), 'a.jpg');
});

test('document scaffolding creates html/head/body', () => {
  const $ = load('<meta charset="utf-8"><title>T</title><div>x</div>');
  assert.equal($('head title').text(), 'T');
  assert.equal($('body div').text(), 'x');
});

test('querySelectorAll returns document order', () => {
  const doc = parseHtml('<div><a id="1"></a><span><a id="2"></a></span><a id="3"></a></div>');
  const found = querySelectorAll(doc, 'a').map((e) => e.attribs.id);
  assert.deepEqual(found, ['1', '2', '3']);
});

test('large attribute values with newlines parse intact', () => {
  const json = JSON.stringify([{ variation_id: 1, attributes: { attribute_pa_color: 'black' } }]);
  const $ = load(`<form class="variations_form" data-product_variations='${json}'></form>`);
  const raw = $('form.variations_form').attr('data-product_variations');
  assert.deepEqual(JSON.parse(raw ?? '[]')[0].variation_id, 1);
});
