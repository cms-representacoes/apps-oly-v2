# -*- coding: utf-8 -*-
"""
Base de produtos da Matriz Esportes
===================================

Gera `base_produtos.json`, o catálogo em que o admin do Estoque Virtual
procura um produto para cadastrar quando a loja avisa que tem no físico
algo que não está na lista dela.

Nada aqui é inventado: a base junta o que os outros aplicativos já
publicam, e a foto vem dos dois bancos de imagens que já existem.

  produtos            apps-oly-v2/Produtos.xlsx e produtos_ua.xlsx (Catálogo Digital)
                      apps-oly/data/produtos.json                   (CMS PASS)
                      apps-oly/data/disponibilidades.json           (Disponibilidades)
                      apps-oly/data/dispo.json                      (lotes de repasse)
                      apps-oly/data/detalhada.json                  (carteira dos clientes)
                      apps-oly/data/matriz_estoque.json             (o que as lojas já têm)
  fotos               apps-oly-v2/imagens_olympikus/                (banco do Catálogo Digital)
                      apps-oly/Catalogo/                            (banco do CMS PASS)

Só entram calçados e chinelos — é o que as lojas da Matriz trabalham
(OLY FTW, OLY CHI e UA FTW). Roupa, meia e acessório ficam de fora para a
busca não se encher de coisa que ninguém vai cadastrar.

Para atualizar: `python gerar_base_produtos.py` e publicar o JSON.
"""
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import openpyxl

AQUI = os.path.dirname(os.path.abspath(__file__))
V2 = os.path.dirname(AQUI)                               # apps-oly-v2
OLY = os.path.join(os.path.dirname(V2), 'apps-oly')      # apps-oly, ao lado
SAIDA = os.path.join(AQUI, 'base_produtos.json')

BANCO_V2 = os.path.join(V2, 'imagens_olympikus')
BANCO_CAT = os.path.join(OLY, 'Catalogo')


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', s).strip().upper()


def artigo_limpo(a):
    a = str(a or '').strip()
    if re.fullmatch(r'\d+\.0', a):
        a = a[:-2]
    return a.upper()


def marca_por_artigo(a):
    """Olympikus tem artigo de 8 dígitos começando em 43; Under Armour, 7."""
    if re.fullmatch(r'43\d{6}', a):
        return 'OLY'
    if re.fullmatch(r'\d{7}', a):
        return 'UA'
    return ''


TIPO = {'FTW': 'FTW', 'TENIS': 'FTW', 'CALCADO': 'FTW', 'CHI': 'CHI', 'CHINELO': 'CHI'}
FORA = {'V&A', 'VESTUARIO', 'ACC', 'ACESSORIO', 'MEIA', 'MEOLY', 'ACOLY'}

base = {}           # (artigo, cor) -> registro
descr = {}          # artigo -> descrição (a primeira boa que aparecer)
tipo_art = {}       # artigo -> FTW/CHI
genero_art = {}


def anota(artigo, descricao, cor, tipo='', genero='', marca='', imagem=''):
    a = artigo_limpo(artigo)
    c = norm(cor)
    d = str(descricao or '').strip()
    if not a or not c:
        return
    t = TIPO.get(norm(tipo), '')
    if norm(tipo) in FORA:
        t = 'FORA'
    if d and a not in descr:
        descr[a] = d
    if t and a not in tipo_art:
        tipo_art[a] = t
    if genero and a not in genero_art:
        genero_art[a] = str(genero).strip().title()
    r = base.setdefault((a, c), {'a': a, 'c': c, 'm': '', 'img': set()})
    m = norm(marca)
    if m.startswith('UA') or 'UNDER' in m:
        r['m'] = 'UA'
    elif m.startswith('OLY') or 'OLYMPIKUS' in m:
        r['m'] = r['m'] or 'OLY'
    if imagem:
        r['img'].add(str(imagem).strip())


# ── Catálogo Digital (Oly e UA) ──
for arq, marca in (('Produtos.xlsx', 'OLY'), ('produtos_ua.xlsx', 'UA')):
    ws = openpyxl.load_workbook(os.path.join(V2, arq), read_only=True, data_only=True).worksheets[0]
    linhas = ws.iter_rows(values_only=True)
    cab = [norm(x) for x in next(linhas)]
    ix = {n: i for i, n in enumerate(cab)}
    for r in linhas:
        g = lambda k: r[ix[k]] if k in ix and ix[k] < len(r) else ''
        anota(g('CODIGO'), g('PRODUTO'), g('COR'), g('CATEGORIA'), g('GENERO'), marca,
              g('IMAGEM') if not str(g('IMAGEM') or '').startswith('=') else '')

# ── CMS PASS ──
for p in json.load(open(os.path.join(OLY, 'data', 'produtos.json'), encoding='utf-8')):
    anota(p.get('codigo'), p.get('produto'), p.get('cor'), p.get('categoria'), p.get('genero'),
          p.get('marca'), p.get('imagem'))

# ── Disponibilidades ──
imgs_disp = json.load(open(os.path.join(OLY, 'data', 'disponibilidades_imagens.json'), encoding='utf-8'))
for p in json.load(open(os.path.join(OLY, 'data', 'disponibilidades.json'), encoding='utf-8')):
    chave = f"{artigo_limpo(p.get('artigo'))}|{str(p.get('cor') or '').strip()}"
    anota(p.get('artigo'), p.get('descricao'), p.get('cor'), p.get('categoriaProduto'), p.get('genero'),
          p.get('marca'), p.get('imagem') or imgs_disp.get(chave, ''))

# ── lotes de repasse: "CODIGO - DESCRICAO" às vezes vem invertido ──
for r in json.load(open(os.path.join(OLY, 'data', 'dispo.json'), encoding='utf-8')):
    cod, prod = str(r.get('codigo') or ''), str(r.get('produto') or '')
    if not re.fullmatch(r'\d{7,8}', cod.strip()) and re.fullmatch(r'\d{7,8}', prod.strip()):
        cod, prod = prod, cod
    anota(cod, prod, r.get('cor'), 'FTW')

# ── Detalhada: carteira de todos os clientes ──
det = json.load(open(os.path.join(OLY, 'data', 'detalhada.json'), encoding='utf-8'))
dic = det['dic']
C_MARCA, C_REF, C_COR = 2, 5, 6
for ln in det.get('l', []):
    try:
        ref, desc = dic['ref'][ln[C_REF]]
        cor = dic['cor'][ln[C_COR]]
        marca = dic['marca'][ln[C_MARCA]]
    except Exception:
        continue
    t = 'FORA' if norm(marca) in FORA else ''
    anota(ref, desc, cor, t, '', marca)

# ── o que as lojas da Matriz já têm (a cor delas às vezes é nome, não código) ──
matriz = json.load(open(os.path.join(OLY, 'data', 'matriz_estoque.json'), encoding='utf-8'))
for loja in matriz.get('lojas', []):
    for marca, itens in (loja.get('marcas') or {}).items():
        for it in itens:
            anota(it.get('artigo'), it.get('descricao'), it.get('cor'),
                  'CHI' if 'CHI' in marca else 'FTW', '', marca)

# ── bancos de imagens ──
def listar(pasta):
    out = {}
    for nome in os.listdir(pasta):
        base_, ext = os.path.splitext(nome)
        if ext.lower() in ('.jpg', '.jpeg', '.png', '.webp'):
            out.setdefault(base_.upper(), nome)
    return out

banco_v2 = listar(BANCO_V2)
banco_cat = listar(BANCO_CAT)

# foto sem produto em lista nenhuma: entra se o artigo tem descrição conhecida
for banco in (banco_v2, banco_cat):
    for chave in banco:
        m = re.fullmatch(r'(\d{7,8})_(.+)', chave)
        if not m:
            continue
        a, resto = m.group(1), m.group(2)
        # PRETO__02, PRETO__03... são outros ângulos da mesma cor, e
        # "MRHO.jpg.jpeg" é arquivo salvo com extensão dobrada: nenhum é cor.
        if re.search(r'__\d+$', resto) or '.' in resto:
            continue
        # Artigo que nenhuma lista descreve (coleção antiga, quase sempre) entra
        # assim mesmo, sem descrição: a loja costuma mandar o número do
        # artigo, e é por ele que se acha. Só os prefixos de calçado — 43 da
        # Olympikus, 30 e 60 da Under Armour —, senão entra roupa da UA.
        if a not in descr and not re.match(r'(43\d{6}|30\d{5}|60\d{5})$', a):
            continue
        cor = resto.replace('_', '/')
        if not any(k[0] == a and k[1].replace('/', '_') == resto for k in base):
            anota(a, descr.get(a, ''), cor)

def achar_foto(a, c, extras):
    candidatos = [f'{a}_{c.replace("/", "_")}'.upper()] + [x.upper() for x in extras]
    for cand in candidatos:
        if cand in banco_v2:
            return 'v2', banco_v2[cand]
        if cand in banco_cat:
            return 'cat', banco_cat[cand]
    return '', ''

saida = []
for (a, c), r in base.items():
    t = tipo_art.get(a, '')
    if t == 'FORA':
        continue
    d = descr.get(a, '')
    m = r['m'] or marca_por_artigo(a)
    if not m:
        continue
    banco, arq = achar_foto(a, c, sorted(r['img']))
    saida.append({'a': a, 'd': d, 'c': c, 'm': m, 't': t or 'FTW',
                  **({'g': genero_art[a]} if a in genero_art else {}),
                  **({'b': banco, 'f': arq} if banco else {})})

saida.sort(key=lambda x: (x['d'], x['a'], x['c']))
pacote = {
    'geradoEm': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'bancos': {'v2': '../imagens_olympikus/', 'cat': 'https://cms-representacoes.github.io/apps-oly/Catalogo/'},
    'produtos': saida,
}
json.dump(pacote, open(SAIDA, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

com_foto = sum(1 for x in saida if 'b' in x)
print(f'{len(saida)} produtos (artigo+cor) · {len({x["a"] for x in saida})} artigos · '
      f'{com_foto} com foto ({sum(1 for x in saida if x.get("b") == "v2")} no Catálogo Digital, '
      f'{sum(1 for x in saida if x.get("b") == "cat")} no CMS PASS) · '
      f'OLY {sum(1 for x in saida if x["m"] == "OLY")} · UA {sum(1 for x in saida if x["m"] == "UA")} · '
      f'chinelos {sum(1 for x in saida if x["t"] == "CHI")} · '
      f'{os.path.getsize(SAIDA) // 1024} KB')
