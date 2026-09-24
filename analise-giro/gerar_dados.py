# -*- coding: utf-8 -*-
"""
Análise de Giro — gera o banco de dados (JSON) a partir do plano de contas.

Cada cliente tem o seu plano (.xlsx) com a aba AG: uma linha por produto e,
para cada mês, um bloco de seis colunas — Venda · Estoque · Giro · Cob. ·
Análise · OBS. Daqui sai só o ano corrente (2026), e só o que a tela mostra
nesta primeira etapa: venda, estoque e OBS por mês. Giro e cobertura não são
guardados: a tela calcula a partir de venda e estoque, então nunca ficam
desatualizados.

A carteira que a tela mostra não sai daqui: ela é lida da Detalhada, que se
atualiza todo dia, pelos `codigos` do cliente. A aba CARTEIRA do plano ainda
entra no JSON como registro.

Uso:  python gerar_dados.py            (todos os clientes)
      python gerar_dados.py degraus    (só um)
"""
import datetime as dt
import json
import re
import sys
import unicodedata
from pathlib import Path

import openpyxl

ANO = 2026
PASTA = Path(__file__).resolve().parent / 'dados'
# as fotos dos produtos, as mesmas da Carteira e da Detalhada
FOTOS = Path(__file__).resolve().parent.parent / 'imagens_olympikus'
PLANOS = Path(r'C:\Users\Administrativo\OneDrive\CMS - COMPART\OneDrive\CMS COMPART\A0 PLANO DE CONTAS')

# Um por cliente. O COD_CLIENTE é a chave que casa o relatório do cliente
# com a linha do plano (é por ele que hoje se faz o PROCV), então ele vai
# para o banco mesmo sem ser usado ainda.
CLIENTES = [
    {
        'id': 'degraus',
        'nome': 'Degraus',
        'razao': 'DEGRAUS FPS',
        'codigo': '3834566',
        # códigos do cliente na Detalhada: em 2026 a Degraus trocou a filial de
        # recebimento, e a carteira dela vem pelos dois
        'codigos': ['3834566', '124330'],
        'lider': '104988',
        'lojas': 11,
        'vendedor': 'JORGE',
        'marca': 'Olympikus',
        'arquivo': PLANOS / 'OLYMPIKUS' / 'JORGE' / 'AG DEGRAUS.xlsx',
        'aba': 'AG',
        'aba_carteira': 'CARTEIRA',
    },
    {
        'id': 'degraus-ua',
        'nome': 'Degraus',
        'razao': 'DEGRAUS FPS',
        'codigo': '3834566',
        'codigos': ['3834566', '124330'],
        'lider': '104988',
        'lojas': 9,
        'vendedor': 'JORGE',
        'marca': 'Under Armour',
        'arquivo': PLANOS / 'UNDER ARMOUR' / 'JORGE_MARCOS UA' / 'AG UA DEGRAUS.xlsx',
        'aba': 'AG',
        'aba_carteira': 'CARTEIRA',
    },
]


def norm(t):
    t = unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', t).strip().upper()


def num(v):
    if v in (None, ''):
        return 0
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    return int(round(f)) if abs(f - round(f)) < 1e-9 else round(f, 2)


def texto(v):
    return '' if v in (None, '') else str(v).strip()


# O plano da Olympikus abre a linha do cabeçalho com MARCA/SUB e o da
# Under Armour com MARCAS; o código do cliente é COD_CLIENTE num e
# REF. CLIENTE no outro. Fora isso os dois têm a mesma forma.
CABECALHO = ('MARCA/SUB', 'MARCAS')
ALIAS = {
    'codigo': ('CODIGO',),
    'descricao': ('DESCRICAO PRODUTO', 'DESCRICAO'),
    'cor': ('COR',),
    'genero': ('GENERO',),
    'grupo': ('GRUPO_COLECAO', 'GRUPO COLECAO'),
    'pdv': ('PDV',),
    'cod_cliente': ('COD_CLIENTE', 'REF. CLIENTE', 'REF CLIENTE'),
    'desc_cliente': ('DESC_CLIENTE', 'REF/DESC'),
}


def ler_ag(ws):
    """Produtos e meses do ano, lidos pelo cabeçalho da aba."""
    linhas = ws.iter_rows(values_only=True)
    cab = None
    for r in linhas:
        if r and norm(r[0]) in CABECALHO:
            cab = r
            break
    if cab is None:
        raise SystemExit('Cabeçalho da aba AG não encontrado '
                         f'(esperava {" ou ".join(CABECALHO)} na coluna A).')

    col = {norm(v): i for i, v in enumerate(cab) if isinstance(v, str)}

    def onde(campo, obrigatorio=True):
        for nome in ALIAS[campo]:
            if nome in col:
                return col[nome]
        if obrigatorio:
            raise SystemExit(f'Coluna {ALIAS[campo][0]} não encontrada na aba AG.')
        return None

    ic = {
        'marca': 0,
        'chave': 1,
        'codigo': onde('codigo'),
        'descricao': onde('descricao'),
        'cor': onde('cor'),
        'genero': onde('genero'),
        'grupo': onde('grupo', False),
        'pdv': onde('pdv'),
        'cod_cliente': onde('cod_cliente', False),
        'desc_cliente': onde('desc_cliente', False),
    }
    # blocos de mês: a célula do cabeçalho é a data e é também a coluna de
    # venda; as seguintes são estoque, giro, cob., análise e OBS
    meses = []
    for i, v in enumerate(cab):
        if isinstance(v, dt.datetime) and v.year == ANO and i + 5 < len(cab) \
                and norm(cab[i + 1]) == 'ESTOQUE' and norm(cab[i + 5]) == 'OBS':
            meses.append((f'{v.year}-{v.month:02d}', i))
    if not meses:
        raise SystemExit(f'Nenhum mês de {ANO} encontrado na aba AG.')

    produtos = []
    for r in linhas:
        if not r or not r[ic['codigo']]:
            continue
        m = {}
        for chave, i in meses:
            venda, estoque, obs = num(r[i]), num(r[i + 1]), texto(r[i + 5])
            reg = {}
            if venda:
                reg['v'] = venda
            if estoque:
                reg['e'] = estoque
            if obs:
                reg['o'] = obs
            if reg:
                m[chave] = reg
        # só entra quem teve venda ou estoque no ano; OBS sozinha não conta
        if not any(x.get('v') or x.get('e') for x in m.values()):
            continue
        codigo = r[ic['codigo']]
        produtos.append({
            'k': texto(r[ic['chave']]) or f'{codigo}{texto(r[ic["cor"]])}',
            'marca': texto(r[ic['marca']]),
            'codigo': str(int(codigo)) if isinstance(codigo, float) and codigo.is_integer() else texto(codigo),
            'descricao': texto(r[ic['descricao']]),
            'cor': texto(r[ic['cor']]),
            'genero': texto(r[ic['genero']]).upper(),
            'grupo': texto(r[ic['grupo']]) if ic['grupo'] is not None else '',
            'pdv': num(r[ic['pdv']]) or None,
            'codCliente': texto(r[ic['cod_cliente']]) if ic['cod_cliente'] is not None else '',
            'm': m,
        })
    return [c for c, _ in meses], produtos


def ler_carteira(ws):
    """Previsão de faturamento de 2026: { 'REF|COR': { 'AAAA-MM': pares } }."""
    linhas = ws.iter_rows(values_only=True)
    cab = next(linhas)
    col = {norm(v): i for i, v in enumerate(cab) if isinstance(v, str)}
    ir, ic, ip, iq = col['REFERENCIA'], col['COR'], col['PREV FAT'], col['CART']
    cart = {}
    for r in linhas:
        if not r or not r[ir] or not isinstance(r[ip], dt.datetime) or r[ip].year != ANO:
            continue
        pares = num(r[iq])
        if not pares:
            continue
        chave = f'{texto(r[ir])}|{texto(r[ic])}'
        mes = f'{r[ip].year}-{r[ip].month:02d}'
        cart.setdefault(chave, {})
        cart[chave][mes] = cart[chave].get(mes, 0) + pares
    return cart


def gerar(cli):
    print(f'· {cli["nome"]}: lendo {cli["arquivo"].name}')
    wb = openpyxl.load_workbook(cli['arquivo'], read_only=True, data_only=True)
    meses, produtos = ler_ag(wb[cli['aba']])
    carteira = ler_carteira(wb[cli['aba_carteira']]) if cli.get('aba_carteira') in wb.sheetnames else {}
    wb.close()

    agora = dt.datetime.now().isoformat(timespec='seconds')
    base = {
        'cliente': {k: cli[k] for k in ('id', 'nome', 'razao', 'codigo', 'codigos', 'lider', 'lojas', 'vendedor', 'marca')},
        'ano': ANO,
        'meses': meses,
        'atualizadoEm': agora,
        'fonte': cli['arquivo'].name,
        'produtos': produtos,
        'carteira': carteira,
    }
    PASTA.mkdir(exist_ok=True)
    destino = PASTA / f'{cli["id"]}.json'
    destino.write_text(json.dumps(base, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'  {len(produtos)} produtos · meses {meses[0]} a {meses[-1]} · '
          f'{len(carteira)} itens de carteira → {destino.name} ({destino.stat().st_size // 1024} KB)')
    return {
        'id': cli['id'], 'nome': cli['nome'], 'codigo': cli['codigo'], 'codigos': cli['codigos'], 'lojas': cli['lojas'],
        'vendedor': cli['vendedor'], 'marca': cli['marca'], 'ano': ANO, 'meses': meses,
        'produtos': len(produtos), 'atualizadoEm': agora,
    }


def indice_fotos():
    """Índice das fotos que existem: { 'ARTIGO|COR': 'arquivo.jpg' }.

    A cor entra sem separador nenhum porque os arquivos não seguem um padrão:
    a mesma cor aparece como PTO_LM, PTOLM e PTO/LM. Variações do mesmo
    produto (__02, -3000x3000.raw) ficam de fora — a tela quer uma foto por
    cor, e a principal é a que não tem sufixo.
    """
    if not FOTOS.is_dir():
        print('! pasta de fotos não encontrada:', FOTOS)
        return 0
    idx = {}
    for arq in sorted(FOTOS.iterdir()):
        if arq.suffix.lower() not in ('.jpg', '.jpeg', '.png', '.webp'):
            continue
        nome = arq.stem
        if '__' in nome or '-3000x3000' in nome.lower():
            continue                      # variação da mesma foto
        artigo, _, cor = nome.partition('_')
        if not artigo or not cor:
            continue
        chave = f'{artigo.upper()}|{re.sub(r"[^A-Z0-9]", "", cor.upper())}'
        idx.setdefault(chave, arq.name)   # a primeira em ordem alfabética manda
    destino = PASTA / 'fotos.json'
    PASTA.mkdir(exist_ok=True)
    destino.write_text(json.dumps(idx, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'fotos: {len(idx)} cores com imagem → {destino.name} ({destino.stat().st_size // 1024} KB)')
    return len(idx)


def main():
    so = set(a.lower() for a in sys.argv[1:])
    indice_arq = PASTA / 'clientes.json'
    indice = {}
    if indice_arq.exists():
        indice = {c['id']: c for c in json.loads(indice_arq.read_text(encoding='utf-8'))}
    for cli in CLIENTES:
        if so and cli['id'] not in so:
            continue
        indice[cli['id']] = gerar(cli)
    indice_fotos()
    lista = sorted(indice.values(), key=lambda c: c['nome'])
    indice_arq.write_text(json.dumps(lista, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'índice: {len(lista)} cliente(s) em {indice_arq.name}')


if __name__ == '__main__':
    main()
