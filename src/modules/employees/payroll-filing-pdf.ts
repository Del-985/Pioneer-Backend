import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
export async function form941Pdf(packet:any):Promise<Uint8Array>{
 const doc=await PDFDocument.load(await readFile(resolve('assets/tax/2026/f941.pdf')));
 const form=doc.getForm();form.deleteXFA();
 const font=await doc.embedFont(StandardFonts.Helvetica);
 const input=packet.inputs,l=packet.figures.lines;
 const names=form.getFields().map(f=>f.getName());
 const field=(page:number,short:string)=>{const n=names.find(n=>n.includes('.Page'+page+'[0].')&&n.endsWith('.'+short));if(!n)throw new Error('Official 941 field missing: '+short);return n;};
 const text=(page:number,short:string,value:unknown)=>{const f=form.getTextField(field(page,short));f.setFontSize(9);f.setText(String(value));};
 const check=(page:number,short:string)=>{const box=form.getCheckBox(field(page,short));box.check();box.updateAppearances();};
 const dollars=(page:number,prefix:string,index:number,value:number)=>{
  text(page,prefix+index+'[0]',(value<0?'-':'')+Math.floor(Math.abs(value)/100));
  text(page,prefix+(index+1)+'[0]',String(Math.abs(value)%100).padStart(2,'0'));
 };
 for(const p of [1,2]){text(p,'f1_1[0]',input.ein.slice(0,2));text(p,'f1_2[0]',input.ein.slice(2));text(p,'f1_3[0]',packet.employerName);}
 text(1,'f1_5[0]',input.street);text(1,'f1_6[0]',input.city);text(1,'f1_7[0]',input.state);text(1,'f1_8[0]',input.zip);
 check(1,'c1_1['+(packet.quarter-1)+']');text(1,'f1_12[0]',input.censusEmployees);
 const map:Record<string,number>={line2:13,line3:15,line5aWages:17,line5aTax:19,line5bWages:21,line5bTax:23,line5cWages:25,line5cTax:27,line5dWages:29,line5dTax:31,line5e:33,line5f:35,line6:37,line7:39,line8:41,line9:43,line10:45,line11:47,line12:49,line13:51,line14:53,line15:55};
 for(const [key,index] of Object.entries(map))dollars(1,'f1_',index,l[key]);
 if(!l.line5aWages&&!l.line5cWages)check(1,'c1_3[0]');
 if(l.line15>0)check(1,'c1_4[0]'); // Explicitly authorized carry-forward, never assumed refund routing.
 check(2,'c2_1[1]');
 packet.figures.monthly.forEach((m:any,i:number)=>dollars(2,'f2_',1+i*2,m.federalLiability));
 dollars(2,'f2_',7,l.line12);
 if(input.seasonalEmployer)check(2,'c2_3[0]');
 check(2,'c2_4[1]'); // No third-party designee; signature remains blank.
 text(2,'f2_13[0]',input.signerName);text(2,'f2_14[0]',input.signerTitle);text(2,'f2_15[0]',input.phone);
 form.updateFieldAppearances(font);
 doc.setTitle('Unsigned Form 941 - 2026 Q'+packet.quarter);doc.setSubject('Review both return pages and sign before submitting. Not filed by Pioneer.');
 return doc.save();
}
