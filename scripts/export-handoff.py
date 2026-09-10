"""Export the developer handoff to self-contained HTML and RTL DOCX; stdlib only."""
from pathlib import Path
from html import escape
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'docs' / 'HyperCool_Developer_Handoff_AR.md'
DEST = ROOT / 'docs' / 'handoff'
DEST.mkdir(parents=True, exist_ok=True)
text = SOURCE.read_text(encoding='utf-8')

def blocks(source):
    lines = source.splitlines(); i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip(): i += 1; continue
        if line.startswith('```'):
            code = []; i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i]); i += 1
            i += 1; yield ('code', '\n'.join(code)); continue
        m = re.match(r'^(#{1,6}) (.*)', line)
        if m: yield ('heading', (len(m[1]), m[2])); i += 1; continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [s.strip() for s in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r'[:\- ]+', c) for c in cells): rows.append(cells)
                i += 1
            yield ('table', rows); continue
        if re.match(r'^\d+\. ', line): yield ('item', line); i += 1; continue
        para = [line]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|\d+\. )', lines[i]):
            para.append(lines[i]); i += 1
        yield ('paragraph', ' '.join(para))

content = list(blocks(text))
def inline(value):
    escaped = escape(value)
    escaped = re.sub(r'`([^`]+)`', r'<code dir="ltr">\1</code>', escaped)
    return re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', escaped)

html = []
toc = []; heading_index = 0
for kind, value in content:
    if kind == 'heading':
        level, title = value; heading_index += 1; hid = f'section-{heading_index}'
        if level == 2: toc.append(f'<li><a href="#{hid}">{inline(title)}</a></li>')
        html.append(f'<h{level} id="{hid}">{inline(title)}</h{level}>')
    elif kind == 'code': html.append('<pre dir="ltr"><code>'+escape(value)+'</code></pre>')
    elif kind == 'table':
        html.append('<div class="table-wrap"><table>')
        for index, row in enumerate(value):
            if index == 0: html.append('<thead>')
            if index == 1: html.append('<tbody>')
            tag = 'th' if index == 0 else 'td'
            html.append('<tr>'+''.join(f'<{tag}>{inline(c)}</{tag}>' for c in row)+'</tr>')
            if index == 0: html.append('</thead>')
        if len(value) > 1: html.append('</tbody>')
        html.append('</table></div>')
    else: html.append('<p>'+inline(value)+'</p>')

css = '''@page{size:A4;margin:18mm 14mm}*{box-sizing:border-box}html{scroll-behavior:smooth}body{font:15px/1.85 Arial,Tahoma,sans-serif;color:#17263b;background:#eef1f5;margin:0}main{max-width:1120px;margin:32px auto;background:white;padding:56px}h1{font-size:30px;color:#101e32;border-bottom:4px solid #087f83;padding-bottom:20px;line-height:1.5}h2{font-size:23px;color:#066366;margin-top:40px;border-bottom:1px solid #dce2e9;padding-bottom:10px}h3{font-size:18px}h1,h2,h3{break-after:avoid}p{margin:12px 0}a{color:#066366}code{font:12px/1.7 Consolas,monospace;unicode-bidi:isolate;overflow-wrap:anywhere}pre{background:#f1f4f7;border:1px solid #dce2e9;padding:16px;white-space:pre-wrap;text-align:left;border-radius:6px;break-inside:avoid}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.65;margin:16px 0;table-layout:fixed}th,td{border:1px solid #d4dce4;padding:10px;vertical-align:top;text-align:right;overflow-wrap:anywhere}th{background:#e7f2f1;font-weight:bold}thead{display:table-header-group}tr{break-inside:avoid}.toc{padding:20px;background:#f4f7f8;border:1px solid #dce2e9}.toc ol{columns:2;padding-inline-start:0;list-style:none}.toc a{text-decoration:none}.notice{color:#5a687b;font-size:12px}footer{text-align:center;font-size:11px;margin-top:40px;color:#5a687b}@media(max-width:700px){main{margin:0;padding:24px}.toc ol{columns:1}.table-wrap{overflow:auto}table{min-width:600px}}@media print{body{background:white;font-size:10.5pt;line-height:1.6}main{margin:0;padding:0;max-width:none}h1{font-size:22pt}h2{font-size:16pt;page-break-before:always}h3{font-size:12pt}table{font-size:9pt}th,td{padding:6px}code{font-size:8pt}.toc{font-size:10pt}.toc ol{columns:2}.table-wrap{overflow:visible}a{color:inherit;text-decoration:none}}'''
html_doc='<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperCool — تقرير التسليم الفني الشامل</title><style>'+css+'</style></head><body><main><p class="notice">HYPERCOOL · DEVELOPER HANDOFF · 10 SEPTEMBER 2026</p><nav class="toc" aria-label="فهرس التقرير"><strong>فهرس التقرير</strong><ol>'+''.join(toc)+'</ol></nav>'+''.join(html)+'<footer>لقطة فنية للمصدر وقت المراجعة · راجع الأدلة والاختبارات قبل الإطلاق</footer></main></body></html>'
(DEST/'HyperCool_Developer_Handoff_AR.html').write_text(html_doc,encoding='utf-8')

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
ET.register_namespace('w',W)
def element(name,attrs=None,text=None):
    node=ET.Element('{'+W+'}'+name,{'{'+W+'}'+k:str(v) for k,v in (attrs or {}).items()})
    if text is not None: node.text=text
    return node
def add(parent,name,attrs=None,text=None):
    node=element(name,attrs,text); parent.append(node); return node
def paragraph(value,style=None,ltr=False):
    p=element('p');props=add(p,'pPr')
    if style: add(props,'pStyle',{'val':style})
    add(props,'bidi',{'val':'0' if ltr else '1'});add(props,'jc',{'val':'left' if ltr else 'right'})
    for chunk in re.split(r'(`[^`]+`|\*\*[^*]+\*\*)',value):
        if not chunk: continue
        code=chunk.startswith('`');bold=chunk.startswith('**')
        plain=chunk[1:-1] if code else chunk[2:-2] if bold else chunk
        run=add(p,'r');rpr=add(run,'rPr')
        add(rpr,'rtl',{'val':'0' if ltr or code else '1'})
        if bold: add(rpr,'b');add(rpr,'bCs')
        if code or ltr: add(rpr,'rFonts',{'ascii':'Consolas','hAnsi':'Consolas','cs':'Arial'});add(rpr,'sz',{'val':'18'});add(rpr,'szCs',{'val':'18'})
        t=add(run,'t',text=plain);t.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
    return p

document=element('document');body=add(document,'body')
for kind,value in content:
    if kind=='heading':
        level,title=value;body.append(paragraph(title,style='Title' if level==1 else 'Heading'+str(level-1)))
    elif kind=='code':
        for line in value.splitlines(): body.append(paragraph(line,style='Code',ltr=True))
    elif kind=='table':
        table=add(body,'tbl');props=add(table,'tblPr');add(props,'bidiVisual');add(props,'tblW',{'w':9600,'type':'dxa'});add(props,'tblLayout',{'type':'fixed'})
        borders=add(props,'tblBorders')
        for edge in ['top','left','bottom','right','insideH','insideV']:add(borders,edge,{'val':'single','sz':4,'color':'D4DCE4'})
        margins=add(props,'tblCellMar')
        for edge in ['top','left','bottom','right']:add(margins,edge,{'w':90,'type':'dxa'})
        width=9600//len(value[0]);grid=add(table,'tblGrid')
        for _ in value[0]:add(grid,'gridCol',{'w':width})
        for index,row in enumerate(value):
            tr=add(table,'tr');trpr=add(tr,'trPr');add(trpr,'cantSplit')
            if index==0:add(trpr,'tblHeader')
            for cell in row:
                tc=add(tr,'tc');tcpr=add(tc,'tcPr');add(tcpr,'tcW',{'w':width,'type':'dxa'})
                if index==0:add(tcpr,'shd',{'fill':'E7F2F1'})
                tc.append(paragraph('**'+cell+'**' if index==0 else cell,style='TableText'))
        body.append(paragraph(''))
    else:body.append(paragraph(value))
sect=add(body,'sectPr');add(sect,'pgSz',{'w':11906,'h':16838});add(sect,'pgMar',{'top':1000,'right':1000,'bottom':1000,'left':1000,'header':450,'footer':450})
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
footer_ref=add(sect,'footerReference',{'type':'default'});footer_ref.set('{'+R+'}id','rIdFooter')
styles=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ar-SA" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/><w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'''
for name,size,color in [('Normal',22,'17263B'),('Title',36,'101E32'),('Heading1',30,'066366'),('Heading2',25,'066366'),('TableText',20,'17263B'),('Code',18,'17263B')]:
    heading=name.startswith('Heading') or name=='Title'
    page_break='<w:pageBreakBefore/>' if name=='Heading1' else ''
    styles+=f'<w:style w:type="paragraph" w:styleId="{name}"><w:name w:val="{name}"/><w:pPr><w:bidi/>{page_break}{"<w:keepNext/>" if heading else ""}<w:spacing w:before="120" w:after="120"/>{"<w:outlineLvl w:val=\"0\"/>" if name=="Heading1" else ""}</w:pPr><w:rPr><w:sz w:val="{size}"/><w:szCs w:val="{size}"/><w:color w:val="{color}"/>{"<w:b/><w:bCs/>" if heading else ""}</w:rPr></w:style>'
styles+='</w:styles>'
footer=element('ftr');p=paragraph('HyperCool · تقرير التسليم الفني · ');p.find('{'+W+'}pPr').find('{'+W+'}jc').set('{'+W+'}val','center');field=add(p,'fldSimple',{'instr':'PAGE'});run=add(field,'r');add(run,'t',text='1');footer.append(p)
parts={
 '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
 '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
 'word/document.xml':ET.tostring(document,encoding='utf-8',xml_declaration=True),
 'word/styles.xml':styles,
 'word/footer1.xml':ET.tostring(footer,encoding='utf-8',xml_declaration=True),
}
target=DEST/'HyperCool_Developer_Handoff_AR.docx'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
    for name,data in parts.items():archive.writestr(name,data)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():ET.fromstring(archive.read(name))
print(f'Exported {len(content)} blocks, {len(toc)} sections, {len(text.split())} words; validated DOCX XML and ZIP.')
