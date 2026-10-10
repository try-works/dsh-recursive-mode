// Measurement harness for the generated workflow page.
// Copies the page, injects a measuring script, renders it in the REAL headless
// Chromium, and reports measured geometry. The shipped file is never edited.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe'
const SRC = 'workflow-map/recursive-mode-workflow.html'
// [tab id, panel id] — every view that carries substantial text.
const VIEWS = [
  ['overview', 'panel-overview'], ['graph', 'panel-graph'], ['training', 'panel-training'],
  ['guards', 'panel-guards'], ['verify', 'panel-verify'], ['loops', 'panel-loops'],
  ['phase-01-as-is-md', 'panel-phase-01-as-is-md'], ['phase-08-memory-impact-md', 'panel-phase-08-memory-impact-md'],
]
const WIDTHS = [480, 700, 900, 1100, 1280, 1440, 1920]

const MEASURE = `
<script>
(function(){
  function isOverlay(el){
    return !!(el.closest('.tabstrip')||el.closest('.skip')||el.classList.contains('rail-dot'));
  }
  function report(){
    var out={w:innerWidth,h:innerHeight,docW:document.documentElement.scrollWidth,panels:[]};
    var panels=document.querySelectorAll('.panel');
    for(var i=0;i<panels.length;i++){
      if(panels[i].hidden) continue;
      var panel=panels[i];
      var items=[];
      var walk=panel.querySelectorAll('*');
      for(var k=0;k<walk.length;k++){
        var el=walk[k];
        if(el.closest('svg')) continue;
        var hasText=false;
        for(var n=0;n<el.childNodes.length;n++){ if(el.childNodes[n].nodeType===3 && el.childNodes[n].textContent.trim().length>0){hasText=true;break;} }
        if(!hasText) continue;
        var hasTextChild=false;
        for(var n2=0;n2<el.children.length;n2++){
          var ch2=el.children[n2];
          for(var n3=0;n3<ch2.childNodes.length;n3++){ if(ch2.childNodes[n3].nodeType===3 && ch2.childNodes[n3].textContent.trim().length>0){hasTextChild=true;break;} }
          if(hasTextChild) break;
        }
        if(hasTextChild) continue;
        var s=getComputedStyle(el);
        if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0) continue;
        var b=el.getBoundingClientRect();
        if(b.width<1||b.height<1) continue;
        items.push({t:(el.textContent||'').trim().slice(0,30),x:b.left,y:b.top,w:b.width,h:b.height,tag:el.tagName,ov:isOverlay(el)});
      }
      var ov=0,worst=0,samples=[],ovRaw=0,worstRaw=0,samplesRaw=[];
      var pad=0.5;
      for(var a=0;a<items.length;a++){
        for(var b2=a+1;b2<items.length;b2++){
          var A=items[a],B=items[b2];
          if(A.tag==='TD'&&B.tag==='TD') continue;
          var ax=Math.min(A.x+A.w,B.x+B.w)-Math.max(A.x,B.x);
          var ay=Math.min(A.y+A.h,B.y+B.h)-Math.max(A.y,B.y);
          if(ax<=pad||ay<=pad) continue;
          if((A.x>=B.x&&A.x+A.w<=B.x+B.w&&A.y>=B.y&&A.y+A.h<=B.y+B.h)||
             (B.x>=A.x&&B.x+B.w<=A.x+A.w&&B.y>=A.y&&B.y+B.h<=A.y+A.h)) continue;
          var d=Math.min(ax,ay);
          var involvesOverlay=A.ov||B.ov;
          ovRaw++; if(d>worstRaw)worstRaw=d;
          if(samplesRaw.length<2) samplesRaw.push((involvesOverlay?'[overlay] ':'')+A.tag+':'+A.t.slice(0,16)+' >< '+B.tag+':'+B.t.slice(0,16)+' '+ax.toFixed(1)+'x'+ay.toFixed(1));
          if(involvesOverlay) continue;
          ov++; if(d>worst)worst=d;
          if(samples.length<3) samples.push(A.tag+':'+A.t.slice(0,16)+' >< '+B.tag+':'+B.t.slice(0,16)+' '+ax.toFixed(1)+'x'+ay.toFixed(1));
        }
      }
      out.panels.push({id:panel.id,items:items.length,overlaps:ov,worst:Math.round(worst*100)/100,samples:samples,
        overlapsRaw:ovRaw,worstRaw:Math.round(worstRaw*100)/100,samplesRaw:samplesRaw});
    }
    var pre=document.createElement('pre'); pre.id='DSH_MEASUREMENT';
    pre.textContent=JSON.stringify(out);
    document.body.appendChild(pre);
  }
  if(document.readyState==='complete') report(); else addEventListener('load',report);
})();
</script>
`

const dir = mkdtempSync(join(tmpdir(), 'wfm-'))
const rows = []
for (const [view, panelId] of VIEWS) {
  for (const w of WIDTHS) {
    const target = join(dir, view + '-' + w + '.html')
    writeFileSync(target, readFileSync(SRC, 'utf8').replace('</body>', MEASURE + '\n</body>'), 'utf8')
    let dom = ''
    try {
      dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--virtual-time-budget=3000', '--window-size=' + w + ',1000',
        '--dump-dom', 'file:///' + target.replace(/\\/g, '/').replace(/^\/+/, '') + '#' + view],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (e) { dom = (e && e.stdout) ? e.stdout.toString() : '' }
    const m = dom.match(/<pre id="DSH_MEASUREMENT">([\s\S]*?)<\/pre>/)
    if (!m) { rows.push({ view, w, error: 'no measurement node' }); continue }
    const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    const panel = data.panels.find((p) => p.id === panelId)
    rows.push({ view, w, inner: data.w, docW: data.docW, panel })
  }
}

console.log('view                  width  inner  docScrollW  measured  overlaps  worst  rawOverlap  rawWorst')
let bad = 0
for (const r of rows) {
  if (r.error || !r.panel) { console.log(r.view.padEnd(21) + String(r.w).padStart(5) + '  ' + (r.error || 'panel not rendered')); bad++; continue }
  const p = r.panel
  if (p.overlaps > 0) bad++
  console.log(r.view.padEnd(21) + String(r.w).padStart(5) + String(r.inner).padStart(7) + String(r.docW).padStart(12)
    + String(p.items).padStart(10) + String(p.overlaps).padStart(10) + String(p.worst).padStart(7)
    + String(p.overlapsRaw).padStart(12) + String(p.worstRaw).padStart(9) + (p.overlaps > 0 ? '  <-- REAL OVERLAP' : ''))
  for (const s of (p.samples || [])) console.log('        REAL: ' + s)
  if (p.overlaps === 0 && p.overlapsRaw > 0) for (const s of (p.samplesRaw || [])) console.log('        raw(excluded): ' + s)
}
console.log('\n' + rows.length + ' renders; ' + (bad === 0 ? 'CLEAN — 0 real text-on-text overlaps' : bad + ' render(s) with REAL overlaps'))
