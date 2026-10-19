// NOAA general solar equations. UTC calculations avoid timezone/DST assumptions.
// Reference: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
export function solarLight(lat,lon,at){
 const stamp=new Date(at),rad=Math.PI/180;
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||!Number.isFinite(+stamp))return null;
 const year=stamp.getUTCFullYear(),start=Date.UTC(year,0,1),day=Math.floor((+stamp-start)/86400000)+1,hours=stamp.getUTCHours()+stamp.getUTCMinutes()/60;
 const gamma=2*Math.PI/365*(day-1+(hours-12)/24);
 const eq=229.18*(.000075+.001868*Math.cos(gamma)-.032077*Math.sin(gamma)-.014615*Math.cos(2*gamma)-.040849*Math.sin(2*gamma));
 const decl=.006918-.399912*Math.cos(gamma)+.070257*Math.sin(gamma)-.006758*Math.cos(2*gamma)+.000907*Math.sin(2*gamma)-.002697*Math.cos(3*gamma)+.00148*Math.sin(3*gamma);
 const solarMinutes=((hours*60+eq+4*lon)%1440+1440)%1440,angle=(solarMinutes/4-180)*rad;
 const altitude=Math.asin(Math.max(-1,Math.min(1,Math.sin(lat*rad)*Math.sin(decl)+Math.cos(lat*rad)*Math.cos(decl)*Math.cos(angle))))/rad;
 const cosine=(Math.cos(90.833*rad)/(Math.cos(lat*rad)*Math.cos(decl)))-Math.tan(lat*rad)*Math.tan(decl);
 const midnight=Date.UTC(year,stamp.getUTCMonth(),stamp.getUTCDate()),noonMinutes=720-4*lon-eq;
 // Pick the solar day nearest this instant, also for longitudes near the date line.
 let noon=midnight+noonMinutes*60000;noon+=Math.round((+stamp-noon)/86400000)*86400000;
 const span=Math.abs(cosine)<=1?Math.acos(cosine)/rad*4*60000:null;
 return {phase:altitude>=-.833?'day':altitude>=-6?'twilight':'night',altitude,sunrise:span===null?null:new Date(noon-span).toISOString(),sunset:span===null?null:new Date(noon+span).toISOString(),polar:span===null?(altitude>0?'day':'night'):null};
}
