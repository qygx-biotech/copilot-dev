"""Lossless original-text PDF fixture container; no expected answers are read."""
import io
import json
import os
import sys

from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

value = json.load(sys.stdin)
font_path = os.environ.get('BIODESIGN_EVAL_FONT', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
pdfmetrics.registerFont(TTFont('FixtureUnicode', font_path))
output = io.BytesIO()
pdf = canvas.Canvas(output, pagesize=(612, 842), invariant=1, pageCompression=0)
pdf.setTitle(value.get('title', 'Original synthetic fixture'))
pages = {int(page['page']): page['text'] for page in value['pages']}
for page in range(1, max(pages, default=1) + 1):
    pdf.setFont('FixtureUnicode', 9)
    y = 805
    for paragraph in pages.get(page, '').split('\n'):
        line = ''
        for character in paragraph:
            if pdfmetrics.stringWidth(line + character, 'FixtureUnicode', 9) > 530:
                if y < 30:
                    raise ValueError('Original fixture page exceeds page container capacity')
                # Never insert a line break inside an English/scientific token.
                # Chinese text can break at character boundaries.
                tail = ''
                if ' ' in line and not character.isspace():
                    line, tail = line.rsplit(' ', 1)
                    tail += ' '
                pdf.drawString(40, y, line)
                y -= 12
                line = tail.rstrip()
            line += character
        if y < 30:
            raise ValueError('Original fixture page exceeds page container capacity')
        pdf.drawString(40, y, line)
        y -= 12
    pdf.showPage()
pdf.save()
sys.stdout.buffer.write(output.getvalue())
