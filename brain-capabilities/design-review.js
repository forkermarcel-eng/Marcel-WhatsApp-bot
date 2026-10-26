// Original conservative review hints. Never establishes a design verdict.
export function reviewDesignArtifact({html='',css='',brandBrief='',screenshots=[]}={}){
 if(typeof html!=='string'||typeof css!=='string'||html.length+css.length>200000)throw Error('Bounded HTML/CSS required');const findings=[];
 const cards=(html.match(/class=["'][^"']*\bcard\b[^"']*["']/gi)||[]).length;
 if(cards>=3&&/hero/i.test(html))findings.push({rule:'stock_hero_card_structure',severity:'info',reason:'Hero plus repeated card classes; check whether the composition follows the actual brief.'});
 if((css.match(/(?:linear|radial)-gradient\(/g)||[]).length>=3&&!brandBrief.trim())findings.push({rule:'unmotivated_gradient_cluster',severity:'info',reason:'Several gradients without a recorded brand rationale; inspect the actual rendering.'});
 if(/revolutionary|game.changing|unlock your potential|revolutionär|entfessle dein potenzial/i.test(html))findings.push({rule:'generic_promotional_copy',severity:'info',reason:'Possible stock promotional wording; verify relevance to the brand.'});
 if(!screenshots.length)findings.push({rule:'visual_evidence_missing',severity:'review',reason:'No actual screenshot evidence supplied. Source inspection is not visual acceptance.'});
 return{mode:'observe',findings,screenshots:screenshots.length,automaticRewrite:false,notice:'Heuristics can flag intentional design. Human review of rendered artifacts remains required.'};
}
