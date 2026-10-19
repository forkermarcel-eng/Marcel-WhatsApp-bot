import {hash,secretRisk} from '../brain-knowledge/model.js';
export function prepareRecipeSource({text,url,title='Manuelles Rezept'}={}){
 if(typeof text!=='string'||text.length<35||text.length>30000||secretRisk(text))throw Error('Lesbarer, freigegebener Rezepttext erforderlich.');
 const source=new URL(url);if(source.protocol!=='https:'||source.username||source.password)throw Error('Öffentlicher HTTPS-Quellenlink erforderlich.');
 return {id:hash([source.href,text]),contentHash:hash(text),path:source.href,title:String(title).slice(0,180),project:'marcel',domain:'PERSONAL_KNOWLEDGE',kind:'recipe',reviewAll:true,status:'processed',authority:'owner_supplied_recipe_excerpt',blocks:[{text,locator:source.href,section:'Rezeptvorschlag – Zutaten und Mengen prüfen'}]};
}
export function prepareSocialDraft({text,media=[],platform}={}){
 if(!['instagram','tiktok','x'].includes(platform)||typeof text!=='string'||!text.trim()||text.length>10000||secretRisk(text))throw Error('Ungültiger Entwurf.');
 if(!Array.isArray(media)||media.some(item=>item.ownerRightsConfirmed!==true||typeof item.assetId!=='string'||!item.assetId))throw Error('Eigene Medien und bestätigte Nutzungsrechte erforderlich.');
 return {id:hash([platform,text,media.map(item=>item.assetId)]),platform,text,media:media.map(item=>({assetId:item.assetId,ownerRightsConfirmed:true})),status:'draft',publishingEnabled:false,requiresOwnerApproval:true};
}
