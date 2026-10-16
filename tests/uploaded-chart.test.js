const assert=require('node:assert/strict'),B=require('../build_review_manifest'),R=require('../refresh_review_manifest');
const url='https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/position-chart-media?id=10000000-0000-0000-0000-000000000001';
const p={ticker:'BTC',direction:'long',opened_at:'2026-09-01',closed_at:'2026-10-01',result_rr:1,
 events:[{id:1,event_type:'closed',triggered_at:'2026-10-01',message_id_en:2,chart_image_url:url,chart_url:'https://www.tradingview.com/x/ABC123/'}],partial_closes:[]};
const clean=R.sanitizePositions([p])[0];
assert.equal(clean.events[0].chart_image_url,url);
const html=B.renderBotCard(clean,{entryISO:'2026-09-01',exitISO:'2026-10-01'},'en');
assert.ok(html.includes('src="'+url+'"'));
assert.ok(html.includes('href="https://www.tradingview.com/x/ABC123/"'));
for(const file of ['dashboard.html','trades.html','equities-trades.html']){
 const csp=require('fs').readFileSync(file,'utf8').match(/img-src ([^;]+)/)[1];
 assert.ok(csp.includes('https://obujqvqqmyfcfflhqvud.supabase.co'),file+' must allow uploaded charts');
}
console.log('EN uploaded chart and source link preserved');
