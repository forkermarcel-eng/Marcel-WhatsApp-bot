// Runs inside an opaque sandbox: no access to the application's cookies or DOM.
(()=>{
 if(location.protocol!=='data:'||location.origin!=='null'){document.body.textContent='Diese Marktanzeige wird ausschließlich isoliert im Finanzportal geladen.';return;}
 const host=document.querySelector('.tradingview-widget-container'),slot=host.querySelector('.tradingview-widget-container__widget');
 const notify=state=>parent.postMessage({type:'marcel-finance-widget',state},'*');
 const fail=()=>{slot.innerHTML='<p class="widget-error">TradingView ist derzeit nicht erreichbar. Nachrichten und Wirtschaftskalender funktionieren weiterhin.</p>';notify('error');};
 const config={width:'100%',height:'100%',locale:'de_DE',colorTheme:'dark',isTransparent:true,showSymbolLogo:true,symbolsGroups:[{name:'Marktübersicht',symbols:[{name:'INDEX:DEU40',displayName:'DAX · Schlusskurs (EOD)'},{name:'FOREXCOM:SPXUSD',displayName:'S&P 500 · CFD-Referenz'},{name:'FOREXCOM:NSXUSD',displayName:'Nasdaq 100 · CFD-Referenz'},{name:'TVC:GOLD',displayName:'Gold · CFD, USD/Unze'},{name:'TVC:UKOIL',displayName:'Brent · CFD-Referenz'},{name:'FX:EURUSD',displayName:'EUR / USD'}]}]};
 config.showChart=false;config.tabs=config.symbolsGroups.map(g=>({title:g.name,symbols:g.symbols.map(x=>({s:x.name,d:x.displayName}))}));delete config.symbolsGroups;
 const observer=new MutationObserver(()=>{const frame=slot.querySelector('iframe')||host.querySelector('iframe');if(frame){frame.title='TradingView Marktübersicht';frame.addEventListener('load',()=>notify('frame-loaded'),{once:true});observer.disconnect();}});observer.observe(host,{childList:true,subtree:true});
 const script=document.createElement('script');script.async=true;script.src='https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';script.textContent=JSON.stringify(config);script.onerror=fail;host.append(script);
 document.addEventListener('securitypolicyviolation',()=>notify('error'));
})();
