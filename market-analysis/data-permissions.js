// Pure technical release gate. Evidence must be supplied server-side, never by API clients.
export function assessDataPermission(source,evidence=null,now=Date.now()) {
 const current=value=>value?.confirmed===true&&typeof value.reference==='string'&&!!value.reference.trim()&&Number.isFinite(Date.parse(value.checkedAt))&&Date.parse(value.checkedAt)<=now&&Date.parse(value.expiresAt)>now;
 const technical=source.networkImplemented===true,documented=typeof source.url==='string'&&source.url.startsWith('https:')&&evidence?.sourceId===source.id&&current(evidence.documentation);
 const matches=evidence?.sourceId===source.id;
 const entitlement=matches&&current(evidence.entitlement),usageRights=matches&&current(evidence.usageRights);
 const productionAllowed=technical&&documented&&entitlement&&usageRights;
 const activationApproved=productionAllowed&&current(evidence.activation);
 return {sourceId:source.id,technical,documented,entitlement:!!entitlement,usageRights:!!usageRights,productionAllowed:!!productionAllowed,activationApproved:!!activationApproved,enabled:!!activationApproved};
}
export function requireDataPermission(source,evidence,now){if(!assessDataPermission(source,evidence,now).enabled)throw Object.assign(new Error('SOURCE_RELEASE_NOT_CONFIRMED'),{code:'SOURCE_RELEASE_NOT_CONFIRMED'});}
