# Controle de Estoque — versão inicial

Aplicação de almoxarifado em português, com Flask, PostgreSQL no Neon e frontend responsivo sem dependências externas. Preparada para Vercel. Não contém senhas padrão, chave pública de banco nem conexão direta do navegador ao Neon.

## Funcionalidades

- Login e senha com hash scrypt; perfis Administrador e Usuário.
- Gestão de usuários: criar, editar nome/login/perfil/senha, excluir cadastro sem histórico ou desativar com histórico. Alterações revogam as sessões do usuário.
- Dashboard e relatórios por data inicial/final e usuário. Usuário comum vê somente seus atendimentos. Retiradas separadas por unidade, quantidade de atendimentos e valor das saídas.
- Pesquisa por código/descrição/localização; material identificado por **código + centro + depósito**, como texto.
- Atendimento com OS, recebedor e vários materiais; responsável pela liberação e horário registrados pelo servidor.
- Correção de quantidades dos próprios atendimentos no ciclo atual, com justificativa e controle de versão. Administrador pode corrigir todos. Cancelamento restaura saldo e preserva itens e histórico; não apaga a retirada. Ciclos encerrados e atendimentos confirmados no SAP não são alterados diretamente.
- Comprovante para impressão; XLSX de relatórios e ciclo completo, agrupamento por OS/material/centro/depósito para SAP (movimento 261), confirmação do documento SAP.
- Cadastro manual de material, edição de descrição/localização/mínimo, exclusão/inativação e contagem de inventário com auditoria. Exclusão exige saldo zero. Inserção manual de saldo inicial exige exportação em dia; não substitui a base inteira.
- Importação XLSX validada e atômica; modelo para download; alerta específico de saldos iguais.
- Temas claro/escuro, PWA instalável, catálogo e histórico próprio em IndexedDB e até **10 atendimentos offline por dispositivo**. Cada atendimento pode conter vários itens.

## Regra de saldo e atualização da base

Uma base aceita inicia um ciclo. Saldo atual = posição importada − saídas ativas do ciclo + ajustes/correções registrados. Confirmar documento SAP **não aumenta o saldo**, apenas registra a conciliação.

Antes de substituir a base:

1. Exporte o **ciclo completo**. Relatório filtrado não libera importação.
2. Qualquer novo atendimento, correção, cancelamento, ajuste, alteração de material ou confirmação SAP invalida a certificação anterior: exporte de novo.
3. Confira o download e concilie no SAP. **Exportado não significa lançado no SAP.** A nova base deve já incorporar todas as baixas dos ciclos anteriores. A tela exige declaração explícita dessa conciliação.
4. Valide a nova planilha. Se os mesmos materiais/centros/depósitos tiverem todos os saldos iguais aos da última importação original, será exigida confirmação adicional, mesmo que valores financeiros tenham mudado.
5. Ao confirmar, o servidor revalida arquivo (SHA-256), ciclo, revisão, exportação e igualdade de saldos. Todos os movimentos de escrita usam o bloqueio transacional da linha `state` no PostgreSQL. A importação inteira é confirmada ou revertida.
6. A base é **completa**: ausentes ficam inativos com saldo zero, conforme aviso na prévia. Histórico anterior permanece. Retiradas de ciclos anteriores não são descontadas novamente.

Não use a substituição de base para atualizar parcialmente um depósito. A planilha deve conter toda a posição que será controlada. Um material novo pode ser cadastrado separadamente sem substituir a base.

A exportação é certificada quando o servidor gera o XLSX com sucesso; o navegador/servidor não consegue comprovar que a pessoa salvou fisicamente o download. Confira o arquivo antes de confirmar a base.

## Colunas XLSX

Os dez cabeçalhos são obrigatórios (acentos e maiúsculas são normalizados):

`Material`, `Texto breve material`, `Unid.medida básica`, `Centro`, `Depósito`, `Denominação depósito`, `Marc.p/elim.nív.dep.`, `Tipo de material`, `Utilização livre`, `Val.utiliz.livre`.

- `Utilização livre`: saldo; `Val.utiliz.livre`: valor total desse saldo; custo unitário calculado por divisão.
- Saldo zero exige valor total zero. Valores não negativos e quantidades com até três casas decimais.
- Material com marcador de eliminação preenchido não pode ser retirado.
- Código/centro/depósito devem ser formatados como **texto** no Excel. Zeros perdidos pelo Excel antes da importação não podem ser recuperados. Depósito numérico é normalizado para pelo menos quatro dígitos.
- Rejeita chaves duplicadas, arquivo vazio e cabeçalhos ausentes. Limites desta versão: 3 MB de arquivo, 3,5 MB de requisição, 40 MB descompactados e 10.000 materiais.
- Modelo da planilha: Administração → Atualizar base → Baixar planilha modelo.

## Configuração Vercel + Neon

O código está preparado, mas **não cria nem altera automaticamente infraestrutura**. Nenhuma migração ocorre no build ou no primeiro acesso.

1. Crie/selecionar um banco PostgreSQL no Neon. Use um **branch separado de testes** para homologação.
2. Configure na Vercel a variável `DATABASE_URL` com a conexão **pooled** fornecida pelo Neon. Mantenha os parâmetros TLS. A conexão é usada somente em `app.py`; nunca prefixe a variável com `NEXT_PUBLIC_`.
3. Configure `APP_ORIGIN` com a origem exata do site, por exemplo `https://controle-estoque.vercel.app` (sem barra final). Para um domínio próprio, atualize esse valor. Não permita curingas. Previews devem usar banco de homologação e a própria origem de preview; não reutilize o banco de produção.
4. Inicialize o esquema **fora do build**, em terminal de confiança, usando `DATABASE_URL_UNPOOLED` com a conexão direta de um usuário proprietário. Não coloque a URL em comandos compartilhados nem no repositório.

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Disponibilize DATABASE_URL, DATABASE_URL_UNPOOLED e APP_ORIGIN no ambiente.
flask --app app init-db
flask --app app create-admin
```

O último comando solicita login, nome e senha oculta (mínimo 12 caracteres). A senha não é enviada por URL e não existe endpoint público de bootstrap. O esquema v1 é definido em `models.py`; `init-db` cria tabelas ausentes de forma idempotente, mas não é um mecanismo de upgrade de tabelas existentes. Evoluções do esquema exigem migração versionada.

5. Importe este repositório na Vercel, raiz do projeto `/`, framework **Flask**, Python 3.12 ou posterior. `app.py` é o ponto de entrada. `vercel.json` declara o framework; não configurar diretório de saída estático nem comando de migração no build.
6. Faça o deploy. Entre com o administrador criado. Cadastre usuários e importe a posição completa de estoque.

Para desenvolvimento local, com ambiente e banco de testes já configurados:

```bash
flask --app app run
```

Use `APP_ORIGIN=http://127.0.0.1:5000` ou a origem exata utilizada. Não habilite modo debug em produção.

### Privilégios do banco

Recomendado: conexão direta de proprietário somente para inicialização; role específica para a aplicação, sem privilégios de DDL. Após criar as tabelas, o proprietário pode adaptar e executar:

```sql
-- Crie a role e sua senha pelo painel Neon; substitua estoque_app pela role real.
GRANT USAGE ON SCHEMA public TO estoque_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, login_attempts, materials, attendances, items TO estoque_app;
GRANT SELECT, UPDATE ON state TO estoque_app;
GRANT SELECT, INSERT ON imports, exports, audit TO estoque_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO estoque_app;
```

Use a URL pooled dessa role em `DATABASE_URL`. Não conceda permissões a `PUBLIC`. As sessões e permissões dos usuários finais são controladas pela API; o navegador nunca recebe a credencial do banco.

## Segurança implementada

- Senhas scrypt, tokens de sessão aleatórios armazenados no banco somente por SHA-256, cookies HttpOnly/SameSite=Strict e Secure na Vercel; expiração de 12 horas.
- CSRF por sessão, verificação de Origin, permissão e propriedade dos registros no servidor, SQL parametrizado via SQLAlchemy.
- Rate limit persistente de 10 falhas por login a cada 15 minutos; habilite também regra de limite para `/api/login` no Firewall Vercel para mitigar ataques distribuídos a múltiplos logins.
- HTTPS na hospedagem; conexão Neon em produção força `sslmode=verify-full` com pacote explícito de certificados CA (certifi). Sem segredos em logs de erro ou respostas; parâmetros SQL ocultados.
- CSP sem scripts externos/inline, proteção contra embedding, MIME sniffing, APIs autenticadas com `Cache-Control: no-store`, exportação com neutralização de fórmulas injetadas.
- Decimais no servidor, restrições do banco, bloqueio transacional para concorrência e idempotência por usuário/UUID para reenvios.
- Auditoria e custo/descrição/código/unidade históricos em cada item. O usuário comum não pode apagar o histórico nem editar movimentações de outras pessoas.

Não há modo demonstração com acesso automático em produção. Sem banco/esquema configurado, o sistema falha de forma fechada. Segredos não devem ser adicionados ao Git.

## PWA e offline

Abra uma vez online, entre e sincronize o catálogo. Android: botão Instalar aplicativo ou menu do navegador. iPhone/iPad: Compartilhar → Adicionar à Tela de Início. Requer HTTPS (localhost é exceção de desenvolvimento).

Somente interface pública é guardada pelo Service Worker. Dados autenticados são armazenados em IndexedDB no dispositivo; não ficam no cache HTTP do Service Worker. Use dispositivos autorizados e bloqueio de tela. Não há criptografia local nem autenticação biométrica nesta versão. O perfil local permite consulta e fila offline por até 12 horas desde a última autenticação/sincronização online; revogação no servidor só pode ser verificada após reconectar.

A fila é persistente, atômica e limitada a 10 atendimentos no total do navegador. Retorno da conexão ou abertura do app tenta sincronizar com sessão válida. Execução em segundo plano com o aplicativo fechado não é garantida pelos navegadores. Sessão expirada exige novo login; pendências permanecem.

Saldo insuficiente, material inativo ou troca de ciclo preservam o lançamento para revisão; nunca aceitam saldo negativo silenciosamente. Pendências de ciclo antigo exigem conferência humana antes do reenvio na nova posição. O servidor usa o horário de recebimento/sincronização como data oficial nesta versão. Não edite atendimentos já sincronizados sem internet.

O sistema bloqueia troca de base se houver pendências **neste dispositivo**. Não consegue conhecer filas de dispositivos desconectados: coordene a sincronização de todos antes de fechar o ciclo. O servidor rejeita ciclos antigos após a troca. Não limpe dados do navegador nem desinstale o PWA com pendências.

## Testes e limites de validação

```bash
pip install pytest
python -m pytest -q
npm install --no-save jsdom fake-indexeddb
node tests/ui.cjs
```

Testes cobrem autenticação/CSRF/perfis, saldo, rollback, idempotência, correções, propriedade, filtros, importação condicionada à exportação e confirmação de saldos iguais; a interface verifica filtros, consulta, limite offline, revisão sem perda e sincronização.

Os testes locais usam SQLite isolado; o GitHub Actions configura PostgreSQL 16 isolado e inclui duas retiradas concorrentes disputando o mesmo saldo. O teste de concorrência é pulado quando `TEST_DATABASE_URL` não está definido. Essa variável é exclusiva dos testes: suas tabelas são apagadas/recriadas a cada teste; nunca aponte para um banco com dados. O lock `FOR UPDATE` exige homologação adicional no Neon antes do uso real. Esta versão não foi publicada na Vercel nem validada contra um Neon real durante a criação. Instalação PWA e comportamento visual devem ser homologados em Android/iOS e no domínio final.

Para volumes grandes, evoluir listagens para paginação e importações/exportações para processamento em lotes controlados. Não há conector SAP automático: XLSX e confirmação de documento são operações assistidas. Nem inventário nem registro de documento alteram o SAP.

## Origem das escolhas

Mantém os requisitos definidos para o projeto e incorpora conceitos úteis do controle anterior: entregas com vários materiais, comprovantes, estorno/correção rastreável, inventário e exportação SAP agrupada. Não utiliza Supabase, bibliotecas do ZIP ou as credenciais de qualquer projeto anterior.
