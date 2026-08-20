# CMS · Painel TV — instalação e uso

## O que é
Dois aplicativos + dois arquivos de dados, tudo dentro do repositório `apps-oly-v2`:

| Peça | Caminho no repositório | Quem usa |
|---|---|---|
| **TV** (vitrine) | `tv/index.html` | a TV do escritório — só exibe |
| **Admin** | `tv-admin/index.html` | você — importa a DETALHADA e publica |
| Dados da TV | `data/tv_data.json` | criado pelo Admin na publicação |
| Registro de encomendas | `data/tv_gci_registry.json` | criado pelo Admin (memória dos GCIs) |

Fluxo: **DETALHADA.xlsx → tv-admin (processa + detecta novidades) → publica no GitHub → a TV lê sozinha** (re-consulta a cada 10 min).
Sem worker no caminho: a TV lê o JSON do próprio GitHub Pages (mesma origem), então instabilidade de Cloudflare não afeta a exibição.

## Instalar (uma vez)
1. Suba as pastas `tv/` e `tv-admin/` para a **raiz** do repositório `apps-oly-v2` (mesmo nível onde ficará `data/` — a pasta `data/` o Admin cria sozinho na primeira publicação).
2. Gere um token do GitHub: Settings → Developer settings → **Fine-grained tokens** → repositório **apenas `apps-oly-v2`** → permissão **Contents: Read and write**. Anote a validade no calendário.
   - Pode ser o MESMO token que já usa no widget do KWGT (mesmo repositório, mesma permissão).
3. Abra `https://cms-representacoes.github.io/apps-oly-v2/tv-admin/`, abra "Conexão com o GitHub", cole o token e salve. Ele fica **só no seu navegador** — nunca vai para o repositório.

## Usar (todo dia — ou automatize depois)
1. Abra o **tv-admin**, arraste a `DETALHADA_PREPOSTOS_*.xlsx` do dia.
2. Confira o resumo (carteira, faturado, falta faturar e as **novidades detectadas**).
3. Clique **Publicar agora**. A TV atualiza em até 10 minutos (ou recarregue-a).

### Primeira importação = batismo
Na primeira publicação, todas as 14 mil+ encomendas do arquivo são registradas como
"já conhecidas" e **nenhuma novidade é exibida** — é o ponto de partida.
Da segunda importação em diante, todo GCI inédito vira novidade (cena roxa = hoje,
cena verde = acumulado do mês).

## A TV
- Abra `https://cms-representacoes.github.io/apps-oly-v2/tv/` no Chrome da TV/PC.
- **Um clique** em qualquer lugar entra/sai da tela cheia. O cursor some sozinho.
- 4 cenas em rotação (18 s cada): Carteira do semestre · Falta faturar/Faturado ·
  Novidades hoje · Novidades do mês. Ticker de fatos no rodapé.
- Selo **AO VIVO** quando o dado tem menos de 1 h; depois vira "ATUALIZADO dd/mm hh:mm".
- Se a rede cair, a TV continua exibindo o último dado válido (cache local) — nunca fica preta.

## Regras de negócio embutidas
- Mapeamento por **nome de coluna** (nunca posição) — resistente a colunas extras.
- MARCA → categoria: OLY/UA_TN=Tênis · MEOLY/UA_ME=Meias · ACOLY/UA_AC=Acessórios ·
  CFOLY/UA_CF=Confecção · CHOLY/UA_CH=Chinelo.
- `C M S` e `CHRISTIAN` consolidam em **CMS**.
- Pares de uma encomenda nova = CART + FAT das linhas daquele GCI.
- "Falta faturar" = CART com PREV FAT no mês corrente; projeção usa dias úteis.
- O registro guarda o log de novidades dos últimos 3 meses (o resto é podado).

## Próximos passos naturais
- Automatizar: o script Selenium que baixa a DETALHADA pode publicar direto
  (mesmo padrão do `widget_performance.json`), aposentando o passo manual.
- Lapidar cenas/tempos: durações, textos do ticker e cores estão no topo dos arquivos.
