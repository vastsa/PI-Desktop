import type { ChangelogEntry } from "./changelog.js";

export const ptBREntries: ChangelogEntry[] = [
  {
    "version": "0.15.7",
    "date": "2026-09-25",
    "highlights": [
      "Celebre o Festival do Meio do Outono com uma animação lunar em tela cheia e por tempo limitado na primeira inicialização, que pode ser reproduzida novamente em Configurações.",
      "Use entrada de voz local opcional no Composer, com controles para desenvolvedores, downloads de modelos verificáveis e canceláveis e proteção contra transcrições obsoletas.",
      "Adiciona uma versão portátil do Windows em um único executável, além do instalador e dos arquivos ZIP.",
      "Melhora a estabilidade dos agentes com cancelamento e recuperação mais seguros, catálogos de modelos mais robustos, navegação de lotes de imagens geradas e um painel de trabalho mais responsivo.",
    ],
  },

  {
    "version": "0.15.6",
    "date": "2026-09-23",
    "highlights": [
      "Ative a pesquisa nativa diretamente nos serviços DeepSeek, xAI e OpenAI existentes sem alterar as configurações de conexão salvas.",
      "Adiciona suporte a GPT-6 Astra, Sol e Luna aos catálogos de modelos da OpenAI e do ChatGPT/Codex.",
    ],
  },

  {
    "version": "0.15.5",
    "date": "2026-09-23",
    "highlights": [
      "Adiciona suporte a GPT-6 Astra, Sol e Luna aos catálogos de modelos da OpenAI e do ChatGPT/Codex.",
    ],
  },

  {
    "version": "0.15.2",
    "date": "2026-09-21",
    "highlights": [
      "Gere e edite imagens no chat, escolha um modelo de imagem e crie lotes com a skill imagegen integrada.",
      "Mantém a atividade das ferramentas alinhada à largura da conversa e acomoda rótulos longos corretamente.",
      "Preserva anexos de arquivos colados mesmo quando a colagem termina após a troca de sessão.",
      "Mantém o modelo padrão selecionado ao editar provedores e usa uma alternativa segura se ele for removido.",
      "Facilita a leitura, a navegação e a recuperação das seções expandidas de raciocínio e atividade das ferramentas.",
      "Melhora os layouts do Composer, os controles de raciocínio e a consistência dos temas em todo o espaço de trabalho.",
      "Adiciona em Settings uma opção para repetir tentativas diante de falhas de rede e erros temporários do provedor até obter sucesso.",
    ],
  },

  {
    "version": "0.15.1",
    "date": "2026-09-19",
    "highlights": [
      "Permite parear e gerenciar hosts remotos por SSH em Settings, incluindo login por senha, instalação e reconexão ao iniciar.",
      "Permite configurar o aprimoramento de prompts (modelo, template e raciocínio) no cartão de configurações de IA.",
      "Permite reordenar modelos selecionados por arraste e adiciona a opção de omitir o raciocínio, sem enviar substituição ao provedor.",
      "Permite redimensionar ou recolher a barra lateral e restaurar a largura padrão da barra lateral ou do painel com um clique duplo.",
      "Permite gerenciar projetos em um arquivo organizado por grupos, com inspetor, e importar cada tipo de seu próprio ambiente de trabalho.",
      "Permite buscar e importar em lote skills e servidores MCP de outras ferramentas de agente.",
      "Mantém o item da barra de menus do macOS como item de status nativo, com atalhos de sessão limitados na bandeja.",
      "Distribui versões oficiais do macOS assinadas e notarizadas, com atualizações no aplicativo.",
      "Instala pelo DMG assinado do macOS com dois ícones; a nota sobre abrir versões não assinadas fica apenas no ZIP.",
      "Abre Review somente quando solicitado e, ao abrir uma sessão, mostra o turno mais recente.",
      "Recupera filas de envio travadas e ignora origens de direcionamento falsificadas.",
    ],
  },

  {
    "version": "0.15.0",
    "date": "2026-09-17",
    "highlights": [
      "Permite reordenar, editar, bloquear e promover prompts na fila para que uma mensagem posterior seja executada em seguida.",
      "Clona um repositório Git pela janela de criação de projeto.",
      "Permite ajustar por arraste a largura do conteúdo da conversa dentro da coluna de chat.",
      "Exibe uma opção de nova tentativa quando a instalação de uma skill do mercado falha, em vez de deixar um botão inativo.",
      "Exibe provedores declarados por plugins como linhas nativas, incluindo chaves de API e agentes personalizados confiáveis.",
      "Adiciona aos plugins conexões em tempo real, atalhos globais, permissões de recursos e um canal oficial com cópias de segurança.",
      "Permite que plugins registrem variáveis e recursos de tema, além de um widget flutuante transparente.",
      "Exclui um projeto e as sessões pertencentes a ele após uma segunda confirmação.",
      "Fornece aos subagentes uma lista ordenada de modelos alternativos, permite retomar um subagente concluído pelo mesmo cartão Task e ativar os recursos integrados em Settings.",
      "Abre referências de arquivos nas linhas das ferramentas, mantém a posição de leitura ao expandir detalhes e exibe o realce de aprovação de Plan em uma placa opaca.",
    ],
  },

  {
    "version": "0.14.9",
    "date": "2026-09-17",
    "highlights": [
      "Permite reordenar, editar, bloquear e promover prompts na fila para que uma mensagem posterior seja executada em seguida.",
      "Clona um repositório Git pela janela de criação de projeto.",
      "Permite ajustar por arraste a largura do conteúdo da conversa dentro da coluna de chat.",
      "Exibe uma opção de nova tentativa quando a instalação de uma skill do mercado falha, em vez de deixar um botão inativo.",
      "Exibe provedores declarados por plugins como linhas nativas, incluindo chaves de API e agentes personalizados confiáveis.",
      "Adiciona aos plugins conexões em tempo real, atalhos globais, permissões de recursos e um canal oficial com cópias de segurança.",
      "Permite que plugins registrem variáveis e recursos de tema, além de um widget flutuante transparente.",
      "Exclui um projeto e as sessões pertencentes a ele após uma segunda confirmação.",
      "Fornece aos subagentes uma lista ordenada de modelos alternativos e permite ativar os recursos integrados em Settings.",
      "Abre referências de arquivos nas linhas das ferramentas, mantém a posição de leitura ao expandir detalhes e exibe o realce de aprovação de Plan em uma placa opaca.",
    ],
  },


  {
    "version": "0.14.8",
    "date": "2026-09-14",
    "highlights": [
      "Permite explorar e instalar servidores MCP do registro oficial e de fontes configuradas pelo usuário no mercado de MCP.",
      "Permite explorar e instalar skills de catálogos selecionados e do GitHub no mercado de Skills, com HTTPS público e limites de tamanho.",
      "Distribui a visualização de arquivos como plugin File Manager integrado e permite que um plugin incluído receba atualizações do marketplace.",
      "Adiciona um modo de pré-visualização do painel de trabalho, aumenta para 450 px a largura mínima da coluna de chat e prioriza MainChat no layout de três colunas.",
      "Descobre sessões independentes, envia mensagens de colaboração controladas pelo host e abre links de colaboração.",
      "Permite que subagentes herdem as ferramentas do agente principal, lista recursos integrados em Settings, adiciona um subagente de design de UI e exibe um estado distinto durante a criação.",
      "Permite direcionar um turno ativo com Alt+Enter e expandir arquivos de texto colados no Composer para editá-los.",
      "Reprojeta a criação de projetos com espaços de trabalho de várias pastas, memória do projeto e um editor visual de memória.",
      "Instala dependências e skills declaradas por pacotes pi importados, sob os limites de segurança controlados pelo host.",
      "Adiciona chips predefinidos para a janela de contexto e a saída máxima do modelo, mostra intervalos de linhas de Read nos chips de ferramentas e mantém o contexto recuperável após uma compactação malsucedida.",
    ],
  },
  {
    "version": "0.14.6",
    "date": "2026-09-10",
    "highlights": [
      "Avisa quando esta versão é mais antiga que os dados locais ou quando a versão Intel está sendo executada em um Mac com Apple Silicon, em vez de falhar silenciosamente.",
      "Adiciona um plano de controle MCP local para o desktop; plugins revisados só controlam o computador após consentimento nativo.",
      "Adiciona templates predefinidos para subagentes, um seletor de modelos limitado ao provedor e o nível de raciocínio efetivo nos cartões de delegação.",
      "Permite definir aliases para modelos configurados, copiar IDs de modelo e priorizar a API própria do modelo sobre o padrão do provedor.",
      "Substitui a correspondência textual do Edit por operações ancoradas em linhas, com orientações de recuperação específicas para cada erro.",
      "Tenta novamente as chamadas aos provedores até dez vezes, com contagem regressiva visível, e recupera turnos autônomos que só registraram eventos de progresso.",
      "Reprojeta o instalador do macOS, adiciona um executável portátil para Windows e um pacote RPM para Linux, e restaura os ícones da bandeja e do dock do GNOME.",
      "Permite copiar IDs de conversa e abrir pastas de sessão pela barra lateral, com dicas localizadas para ações somente com ícones.",
      "Mostra o status dos processos em tempo real e os intervalos de inatividade na linha de atividade, e adiciona um controle do painel de trabalho fixo à janela de visualização.",
      "Aplica as regras de exclusão do espaço de trabalho, resolve links simbólicos quebrados e verifica novamente a saída de rede dos plugins a cada redirecionamento.",
      "Respeita as regras de bypass do proxy, preserva caracteres colados da área de uso privado e carrega prévias de arquivos sem bloquear o Composer.",
    ],
  },
  {
    "version": "0.14.5",
    "date": "2026-09-09",
    "highlights": [
      "Identifica cada DMG e ZIP do macOS com sua arquitetura nativa, arm64 ou x64.",
    ]
  },
  {
    "version": "0.14.4",
    "date": "2026-09-09",
    "highlights": [
      "Adiciona leituras por intervalo, com limites para arquivos grandes, e concessões de acesso a arquivos para plugins vinculadas a gestos reais de arrastar e soltar.",
      "Torna explícitas e opcionais a assinatura e a notarização no macOS, com instruções para abrir compilações não assinadas confiáveis.",
    ]
  },
  {
    "version": "0.14.3",
    "date": "2026-09-09",
    "highlights": [
      "Identifica claramente os downloads Intel para macOS, deixando explícita a arquitetura do instalador.",
    ]
  },
  {
    "version": "0.14.2",
    "date": "2026-09-08",
    "highlights": [
      "Adiciona um inspetor de uso de contexto que acompanha o modelo selecionado e mostra orientações de compactação.",
      "Melhora a configuração de provedores e modelos com seleção pesquisável, ações em lote e erros de busca mais claros.",
      "Resume automaticamente os títulos das sessões e permite renomear projetos, mantendo os nomes após reiniciar.",
      "Aprimora o painel lateral de subagentes com status em tempo real, cartões de tarefa compactos, identidade do modelo e navegação até a saída mais recente.",
      "Envia notificações nativas para perguntas interativas e aprovações, sem colocar conclusões rotineiras na caixa de entrada.",
      "Adiciona localização da interface em coreano e aprimora as configurações localizadas, o histórico da área de transferência e o tratamento seguro de links.",
    ]
  },
  {
    "version": "0.14.1",
    "date": "2026-09-08",
    "highlights": [
      "Faz a delegação de subagentes herdar o modelo principal quando nenhum modelo de delegação estiver configurado.",
      "Evita que IDs do modelo principal repetidos sejam rejeitados por engano como modelos de delegação indisponíveis.",
    ]
  },
  {
    "version": "0.14.0",
    "date": "2026-09-08",
    "highlights": [
      "Permite configurar proxies HTTP de saída por provedor, com validação e tratamento claro de credenciais SOCKS4 não compatíveis.",
      "Importa perfis de provedores e configurações de modelos do CC Switch e de repositórios locais de agentes.",
      "Adiciona cabeçalhos HTTP personalizados e configurações de User-Agent por provedor, além de uma predefinição MiniMax e erros de busca de modelos mais claros.",
      "Anexa arquivos pelo seletor unificado, com cópias no diretório temporário da sessão e suporte a imagens em linha.",
      "Adiciona interfaces em chinês tradicional, alemão, espanhol e francês, além de configurações pesquisáveis de aparência e provedores.",
      "Ajusta de forma consistente os tamanhos de fonte de leitura, a tipografia e os ícones, e mostra o modelo de subagente selecionado nos cartões de delegação.",
    ]
  },
  {
    "version": "0.13.11",
    "date": "2026-09-07",
    "highlights": [
      "Permite que plugins listem modelos, leiam o contexto de sessões em andamento e solicitem ao host a geração de conclusões, sem receber credenciais.",
    ]
  },
  {
    "version": "0.13.10",
    "date": "2026-09-07",
    "highlights": [
      "Pede confirmação antes de sair (Cmd+Q, bandeja ou menu) para evitar a perda acidental de dados.",
    ]
  },
  {
    "version": "0.13.9",
    "date": "2026-09-06",
    "highlights": [
      "Atualiza a versão para a infraestrutura de lançamento.",
    ]
  },
  {
    "version": "0.13.8",
    "date": "2026-09-06",
    "highlights": [
      "Permite buscar e pré-visualizar arquivos do projeto, inclusive imagens, e abri-los com o aplicativo padrão em uma página de visualização dedicada.",
      "Executa o navegador do painel de trabalho como plugin integrado, com o mesmo isolamento das outras visualizações de plugins.",
      "Mantém os chips de arquivos @ após pressionar Enter e pulsa o chip de modo durante o planejamento.",
      "Abre somente links http(s) e mailto do chat, dos plugins e das pré-visualizações.",
    ]
  },
  {
    "version": "0.13.7",
    "date": "2026-09-06",
    "highlights": [
      "Preserva as respostas concluídas da IA após reiniciar, em vez de mostrar apenas as mensagens do usuário.",
      "Mantém os subagentes em segundo plano em execução até que você ou o agente principal os interrompa.",
      "Permite que o agente escolha um tempo limite de Bash de até seis horas, evitando encerrar tarefas longas após 60 segundos.",
    ]
  },
  {
    "version": "0.13.6",
    "date": "2026-09-06",
    "highlights": [
      "Mantém as mensagens do usuário com arquivos colados proporcionais ao conteúdo, em vez de esticá-las por toda a conversa.",
    ]
  },
  {
    "version": "0.13.5",
    "date": "2026-09-06",
    "highlights": [
      "Remove o intermediário A2A e as ferramentas de conversa entre pares.",
      "Corrige testes do runtime do agente que falharam após a remoção do A2A.",
    ]
  },
  {
    "version": "0.13.4",
    "date": "2026-09-05",
    "highlights": [
      "Adiciona o turco e um seletor de idioma pesquisável em Settings → General.",
      "Transforma o tema em um seletor pesquisável, como o de idioma, incluindo temas de plugins.",
      "Simplifica a lista de serviços ao adicionar provedores, inclui Xiaomi, Zhipu e Z.AI, e torna a lista pesquisável.",
      "Permite relatar um problema em Settings → Info com a versão e o sistema operacional já preenchidos.",
      "Mantém os turnos da conversa em ordem cronológica quando a transcrição ao vivo é mesclada.",
    ]
  },
  {
    "version": "0.13.3",
    "date": "2026-09-05",
    "highlights": [
      "Abre New Task imediatamente em um destino vazio, sem manter a transcrição anterior na tela.",
      "Considera completa uma janela Read preenchida e mantém o chip de truncamento apenas para cortes reais.",
      "Preserva os turnos posteriores da conversa ao alternar entre variantes regeneradas, em vez de restaurar um arquivo desatualizado.",
    ]
  },
  {
    "version": "0.13.2",
    "date": "2026-09-05",
    "highlights": [
      "Preserva rascunhos não enviados do Composer, inclusive chips de arquivos, quando o campo de entrada é recriado ou a janela fica oculta.",
      "Inicia novas sessões no nível de raciocínio padrão vinculado ao modelo, em vez de sempre usar o nível mais alto.",
      "Mantém as execuções expandidas de subagentes roladas até a saída mais recente e oferece um controle para voltar a ela após rolar para cima.",
      "Mantém disponível o menu de nível de raciocínio ao fixar um nível durante um turno em andamento.",
      "Mantém os campos para adicionar provedores totalmente visíveis e em foco em janelas estreitas.",
      "Alinha a tela de inicialização do macOS ao vidro da barra lateral, evitando que a janela mostre um painel opaco por um instante.",
    ]
  },
  {
    "version": "0.13.1",
    "date": "2026-09-05",
    "highlights": [
      "Insere chips de anexos indivisíveis na linha de entrada do Composer, com altura padrão de três linhas.",
      "Cria pontos de controle das respostas em streaming para que sobrevivam ao encerramento, à perda do sidecar e ao comando Stop, sem reescrever a transcrição.",
      "Oculta conclusões bem-sucedidas da caixa de entrada de notificações.",
      "Remove bordas e divisórias no fluxo e mostra as barras de rolagem somente ao passar o cursor ou durante a rolagem.",
      "Exibe mascotes GIF claros e escuros na tela inicial vazia.",
    ]
  },
  {
    "version": "0.13.0",
    "date": "2026-09-04",
    "highlights": [
      "Adiciona um cartão flutuante às linhas de sessão da barra lateral, mostrando espaço de trabalho, branch e horário da atualização.",
      "Aplica à barra lateral do macOS o material vibrante sob a janela, aprofundando o efeito de vidro.",
      "Remove a linha de junção da barra lateral do macOS, criando uma borda de vidro sem emendas.",
      "Exibe mascotes acenando em animações de oito quadros específicas para cada tema na tela inicial vazia.",
      "Corrige uma falha da barra lateral na primeira renderização, causada por uma variável referenciada antes da definição.",
    ]
  },
  {
    "version": "0.12.4",
    "date": "2026-09-04",
    "highlights": [
      "Mantém o painel de trabalho à direita dentro da janela do aplicativo, permitindo que MainChat se reorganize como a barra lateral esquerda.",
      "Permite redimensionar o painel de trabalho pelo divisor interno com o mouse ou o teclado, sem ultrapassar os limites da janela.",
      "Elimina leituras duplicadas de transcrições paginadas durante a troca de sessão, tornando a navegação mais fluida.",
      "Adiciona um acabamento nativo à superfície da barra lateral do macOS sem alterar seu comportamento de layout.",
    ]
  },
  {
    "version": "0.12.3",
    "date": "2026-09-03",
    "highlights": [
      "Mostra o uso de contexto em relação à janela de contexto publicada para o modelo selecionado.",
      "Mantém consistentes os limites de contexto específicos do modelo nas configurações do provedor, no Composer e no runtime.",
      "Mantém estáveis as orientações contextuais do Composer ao trocar de modelo e durante turnos ativos.",
    ]
  },
  {
    "version": "0.12.2",
    "date": "2026-09-03",
    "highlights": [
      "Corrige a exibição da linha da mensagem do usuário antes da conclusão da ida e volta ao host.",
      "Limpa o rascunho do prompt antes do envio para evitar conteúdo desatualizado.",
      "Exibe transcrições longas sob uma sobreposição de esqueleto para tornar a renderização mais suave.",
    ]
  },
  {
    "version": "0.12.1",
    "date": "2026-09-03",
    "highlights": [
      "Mantém disponíveis os modelos habilitados para delegação de subagentes após salvar as configurações do provedor e reiniciar o aplicativo.",
      "Mantém visíveis as respostas em andamento ao reabrir sessões.",
    ]
  },
  {
    "version": "0.12.0",
    "date": "2026-09-02",
    "highlights": [
      "Coordena subagentes simultâneos pelo protocolo Agent2Agent (A2A): descobre pares em execução como Agent Cards, troca tarefas duráveis e mensagens tipadas, e transmite atualizações das tarefas, substituindo as antigas mensagens entre pares no mesmo processo.",
    ]
  },
  {
    "version": "0.11.4",
    "date": "2026-09-01",
    "highlights": [
      "Publica instaladores nativos DMG e ZIP para Macs Intel junto com as versões para Apple Silicon.",
      "Mantém unificados os canais de atualização do macOS nas duas arquiteturas nativas.",
    ]
  },
  {
    "version": "0.11.3",
    "date": "2026-08-31",
    "highlights": [
      "Atribui a cada subagente seu próprio modelo do catálogo de delegação ou permite herdar o modelo escolhido para a conversa principal.",
      "Permite que subagentes simultâneos troquem mensagens entre si em conversas encadeadas e filtradas por tópico.",
      "Realiza mesas-redondas estruturadas em que vários subagentes debatem um tópico em rodadas e resumem o resultado.",
      "Harmoniza os controles de configuração de modelos — caixa de seleção de delegação, seção de modelo personalizado e tamanhos de fonte — em todos os painéis.",
      "Substitui o texto de dica da delegação por uma dica de ferramenta mais clara com ícone.",
    ]
  },
  {
    "version": "0.11.2",
    "date": "2026-08-31",
    "highlights": [
      "Permite alternar entre conversas recentes sem que a área de chat pisque: cada conversa mantém seu próprio painel e reaparece exatamente como foi deixada, inclusive na posição de rolagem.",
      "Ao voltar a uma conversa que foi rolada para cima, retorna ao mesmo ponto; sessões abertas pela primeira vez continuam começando no turno mais recente.",
      "Permite continuar lendo a conversa atual enquanto outra carrega, sem escurecer a transcrição.",
      "Permite tentar novamente um prompt editado mesmo quando o texto não foi alterado.",
      "Mantém o trabalho na tarefa atual após uma compactação automática do contexto, em vez de o agente retomar uma solicitação antiga.",
    ]
  },
  {
    "version": "0.11.0",
    "date": "2026-08-30",
    "highlights": [
      "Configura um provedor em um único formulário guiado por descoberta, que consulta o serviço de IA sobre seus próprios modelos antes de recorrer ao catálogo integrado.",
      "Permite escolher um modelo em uma lista pesquisável com indicadores de recursos e tamanho do contexto, obtidos do catálogo models.dev.",
      "Permite substituir os recursos de anexos e o nível de raciocínio padrão por vínculo de modelo, exibindo apenas os níveis publicados pelo modelo.",
      "Apresenta uma delegação individual de subagente em seu próprio cartão, com etapas do ciclo de vida, e permite rolar a execução expandida sem alongar a transcrição.",
      "Mantém a estrutura da conversa acessível enquanto o histórico carrega e mostra uma estrutura de carregamento em vez de uma lista vazia durante o carregamento das sessões.",
      "Permite colar um grande bloco de texto no Composer e transferi-lo para um arquivo da sessão, sem que a reorganização do layout bloqueie a digitação.",
      "Mantém a janela no local onde foi solta ao arrastá-la entre monitores e reserva a faixa da barra de título nas páginas de destino do macOS.",
      "Evita perder turnos quando chamadas das ferramentas de arquivo ou pesquisa são rejeitadas e quando o tempo limite de um comando é definido em milissegundos.",
    ]
  },
  {
    "version": "0.10.9",
    "date": "2026-08-28",
    "highlights": [
      "Gerencia skills, subagentes e servidores MCP em um único painel de recursos em Settings, com filtros por nível, pesquisa e remoção confirmada.",
      "Mantém o painel de recursos e a faixa superior de Settings legíveis nos dois temas, com barra de ferramentas e controles de estado vazio no tamanho correto.",
      "Mantém a fluidez de conversas longas ao rolar, trocar de sessão e passar o cursor sobre o minimapa, sem saltos na transcrição.",
      "Carrega todas as linhas de transcrição gravadas por versões anteriores, em vez de exibir sessões antigas vazias.",
      "Trunca a transcrição na mensagem escolhida ao regenerar ou reenviar uma edição e sempre lista sessões bifurcadas na barra lateral.",
      "Determina se um subagente está ativo com base em qualquer resposta, limita os turnos de cada subagente integrado e informa que uma espera expirada ainda está em execução, em vez de marcar falha.",
      "Repete tentativas após uma falha temporária do provedor até quatro vezes, com esperas de 1/2/4/8 segundos e um orçamento compartilhado por turno, e informa a tentativa real durante a transmissão.",
    ]
  },
  {
    "version": "0.10.8",
    "date": "2026-08-26",
    "highlights": [
      "Mantém os controles nativos de janela do Windows isolados das ações do painel em toda a interface sem moldura.",
      "Cria espaços de trabalho temporários e isolados para chats temporários, mantendo seus arquivos separados dos projetos.",
      "Restaura o aprimoramento de prompts no lançador de comandos com um ícone de modelo de bot mais claro.",
      "Exibe as barras de rolagem da barra lateral ao passar o cursor e as mantém discretas quando inativas.",
    ]
  },
  {
    "version": "0.10.7",
    "date": "2026-08-25",
    "highlights": [
      "Mantém os controles de envio e parada do Composer no mesmo espaço fixo, alinhando rascunhos e turnos em execução.",
      "Mantém o aprimoramento de prompts disponível no lançador de comandos, sem um ícone separado na barra de ferramentas.",
      "Deixa as barras de rolagem da barra lateral mais discretas quando inativas, mas fáceis de encontrar durante a navegação.",
    ]
  },
  {
    "version": "0.10.6",
    "date": "2026-08-25",
    "highlights": [
      "Mostra os recursos de Thinking do modelo exato selecionado no Composer, mesmo antes da criação de uma nova sessão.",
      "Inicia novas sessões no nível mais alto publicado pelo modelo de raciocínio selecionado.",
    ]
  },
  {
    "version": "0.10.5",
    "date": "2026-08-25",
    "highlights": [
      "Mantém os controles de janela do Windows isolados das ações do painel em toda a interface sem moldura.",
      "Abre de forma confiável pastas e arquivos de projetos no Windows, inclusive caminhos com o prefixo de comprimento estendido.",
      "Permite editar arquivos CRLF sem alterar o estilo original de fim de linha.",
    ]
  },
  {
    "version": "0.10.4",
    "date": "2026-08-25",
    "highlights": [
      "Exibe apenas modelos de provedores configurados no seletor de conversa e mantém os modelos salvos disponíveis quando a descoberta não funciona.",
      "Mantém opaca a faixa de controles da janela sem moldura, impedindo que o conteúdo da página apareça por trás dos controles nativos.",
      "Mantém estável a largura do chat com o painel de trabalho aberto e restaura os limites da janela somente de chat quando ele é recolhido.",
    ]
  },
  {
    "version": "0.10.3",
    "date": "2026-08-25",
    "highlights": [
      "Melhora o recurso de aprimoramento de prompt em uma única etapa, preservando o rascunho atual e as referências a arquivos.",
      "Mantém as ações de envio e parada do Composer alinhadas ao rascunho visível e à sessão em execução.",
      "Preserva os metadados de delegação em segundo plano entre turnos TaskWait e recargas do renderizador.",
      "Mantém o histórico e a transcrição de sessões derivadas disponíveis imediatamente após a ramificação.",
    ]
  },
  {
    "version": "0.10.2",
    "date": "2026-08-24",
    "highlights": [
      "Mantém o conteúdo do chat e o Composer centralizados de forma confortável quando a barra lateral está recolhida.",
      "Prepara anexos de imagem grandes sem carregar o arquivo inteiro na memória, inclusive ao reproduzir o histórico.",
    ]
  },
  {
    "version": "0.10.1",
    "date": "2026-08-24",
    "highlights": [
      "Enfileira prompts enviados enquanto uma execução está ativa e os entrega em ordem sem perder o rascunho atual.",
      "Limita subagentes em segundo plano com tempos máximos de inatividade e duração total, e mostra quando uma delegação excede o tempo limite.",
      "Carrega históricos longos de sessões em páginas limitadas e busca mensagens anteriores conforme você rola para cima.",
    ]
  },
  {
    "version": "0.10.0",
    "date": "2026-08-21",
    "highlights": [
      "Permite configurar vários modelos por provedor e alternar entre eles diretamente no Composer.",
      "Gerencia os recursos do agente em um painel de configurações reprojetado, com menus e blocos de escopo mais claros.",
      "Expõe o histórico da área de transferência do host aos plugins como um novo recurso.",
      "Mantém sessões vazias de forma persistente para que possam ser exibidas e reutilizadas após reiniciar o aplicativo.",
      "Facilita o uso do seletor de modelos com uma hierarquia de provedores mais clara e rolagem estável.",
      "Sempre informa a contagem total de linhas nos resultados do Read, permitindo paginar arquivos grandes de forma confiável.",
      "Recupera transmissões limitadas por taxa com mais confiabilidade entre novas tentativas.",
      "Revela no gerenciador de arquivos os arquivos selecionados ao abri-los pelo painel Files.",
    ]
  },
  {
    "version": "0.9.1",
    "date": "2026-08-20",
    "highlights": [
      "Diferencia os ícones de projetos fixados para facilitar o reconhecimento na barra lateral.",
      "Evita que a atividade do subagente permaneça em Running após a conclusão.",
      "Alinha páginas e painéis de plugins ao restante da interface do aplicativo.",
      "Reduz a latência de digitação e envio no Composer.",
      "Torna a rolagem de transcrições longas mais suave e evita flashes ao trocar de sessão.",
      "Restaura a linha de apoio da tela inicial vazia e o layout do Composer alinhado à parte inferior.",
    ]
  },
  {
    "version": "0.9.0",
    "date": "2026-08-20",
    "highlights": [
      "Permite explorar arquivos do projeto no painel Files integrado e abri-los com o aplicativo padrão do sistema operacional.",
      "Adiciona ao painel de trabalho visualizações fornecidas por plugins e isoladas, mantendo visíveis a origem no marketplace e o status de versões retiradas.",
      "Remove o terminal interativo integrado, mantendo a saída do Bash na conversa e os shells interativos no terminal externo.",
      "Repete tentativas no próprio turno diante dos limites de taxa do provedor, sem duplicar mensagens do assistente, e oferece Continuar quando o orçamento de novas tentativas se esgota.",
      "Usa um resumo compacto do contexto para ver rapidamente o uso do modelo, das ferramentas, do cache e da compactação.",
      "Apresenta os cinco comandos principais de sessão com dicas localizadas de comandos de barra no Composer.",
      "Mantém alinhados os Composers da tela inicial e da conversa, enquanto as boas-vindas e as dicas de comandos alternam suavemente.",
    ]
  },
  {
    "version": "0.8.1",
    "date": "2026-08-19",
    "highlights": [
      "Permite entrar em várias contas de provedores e escolher qual conta usar para cada provedor.",
      "Usa os recursos de cada modelo para decidir quando há suporte a anexos de imagem.",
      "Permite escolher no Composer o nível de esforço de raciocínio para modelos que oferecem esse recurso.",
      "Mantém uma única instância do PI-Desktop por diretório de dados para evitar conflitos entre sessões.",
      "Organiza Settings em grupos mais claros e simplifica o gerenciamento de contas de provedores.",
      "Mantém os subagentes integrados alinhados ao modo de permissão da conversa principal.",
    ]
  },
  {
    "version": "0.8.0",
    "date": "2026-08-17",
    "highlights": [
      "Permite delegar tarefas a subagentes em segundo plano e aguardar os resultados sem bloquear a conversa.",
      "Aumenta para 10 o limite de subagentes em execução e aplica às tarefas delegadas o escopo de permissões de cada agente.",
      "Adiciona subagentes integrados de exploração e correção para tarefas comuns em segundo plano.",
      "Pergunta uma vez se fechar a janela deve minimizá-la para a bandeja ou encerrar o aplicativo e, em seguida, lembra a escolha.",
      "Permite que os painéis de plugins acompanhem o idioma e o modo de cor do aplicativo.",
      "Repete, no mesmo turno, tentativas após erros de limite de taxa durante a transmissão, em vez de interromper a resposta.",
      "Recupera execuções aprovadas de Plan após uma interrupção do sidecar.",
      "Evita que avisos de falha do sidecar interrompam uma janela que já foi fechada.",
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-08-15",
    "highlights": [
      "Restringe o acesso dos plugins aos arquivos dentro do escopo declarado por cada um e envia arquivos excluídos para a lixeira, facilitando a recuperação.",
      "Mostra o escopo de arquivos declarado por cada plugin junto às permissões.",
      "Limita as solicitações de rede dos plugins à lista de domínios permitidos declarada por cada um.",
      "Encaminha canais desconhecidos dos painéis de plugins para o próprio plugin, mantendo integrações mais avançadas em funcionamento.",
      "Elimina a oscilação da barra lateral ao recolhê-la.",
      "Ancora as edições do agente a linhas específicas para que uma edição interrompida seja recuperada corretamente, em vez de encerrar o turno sem aviso.",
      "Harmoniza a hierarquia tipográfica dos cartões para uma interface mais consistente.",
      "Atualiza o shell do desktop e o runtime do agente para as versões mais recentes do Electron e do pi.",
    ]
  },
  {
    "version": "0.6.0",
    "date": "2026-08-14",
    "highlights": [
      "Abre o inspetor de uso de contexto ao clicar, mostrando as estatísticas de tokens e cache.",
      "Alterna a visibilidade do painel de trabalho por um novo atalho de teclado.",
      "Mantém os rascunhos de novas tarefas fora do histórico até o envio da primeira mensagem.",
      "Adiciona um seletor global de fontes personalizadas e inclui fontes OFL para personalizar a tipografia.",
      "Lembra os plugins usados recentemente no lançador para agilizar o acesso.",
      "Adiciona ao menu de contexto a opção de copiar o caminho da sessão para o modo de desenvolvedor.",
      "Corrige problemas de corte no seletor de fontes e na restauração da fonte padrão do sistema.",
      "Mantém o PI-Desktop no Dock do macOS e no Cmd+Tab após fechar a janela.",
      "Mantém a transcrição do chat na posição mais recente quando o Composer é recolhido após o envio.",
      "Adiciona ao painel de trabalho um estado vazio real, com orientações mais claras.",
    ]
  },
  {
    "version": "0.5.11",
    "date": "2026-08-13",
    "highlights": [
      "Adiciona disponibilidade offline e atualização de metadados ao marketplace de plugins.",
      "Armazena em cache os rascunhos do Composer por conversa para recuperar sessões mais rapidamente.",
      "Localiza os títulos dos painéis de plugins e adapta o acabamento da janela do painel.",
      "Corrige a cor principal do mascote em superfícies escuras.",
      "Reduz a latência do atalho do lançador no macOS para agilizar as interações.",
    ]
  },
  {
    "version": "0.5.10",
    "date": "2026-08-13",
    "highlights": [
      "Aprimora o acabamento da janela do painel de plugins e as áreas seguras, mantendo o conteúdo longe dos controles nativos.",
      "Aprimora a hierarquia da página Plugins e reduz o texto de apresentação para deixar o fluxo de extensões mais claro.",
      "Usa o ícone de modelo de bandeja correto do macOS para uma aparência mais nítida na barra de menus.",
    ]
  },
  {
    "version": "0.5.9",
    "date": "2026-08-13",
    "highlights": [
      "Faz o modo Goal usar o gerenciamento automático de permissões para um fluxo de trabalho mais consistente.",
      "Prepara antecipadamente o lançador global de plugins para abri-lo mais rápido, mesmo quando outra aplicação está em foco.",
      "Fornece aos painéis de plugins janelas com acabamento nativo e controles confiáveis para minimizar, maximizar e fechar.",
      "Atualiza o site de documentação bilíngue com guias e especificações completos em inglês e chinês simplificado.",
    ]
  },
  {
    "version": "0.5.8",
    "date": "2026-08-12",
    "highlights": [
      "Restaura o lançador global de plugins do Windows com Alt+Space, mesmo quando outra aplicação está em foco.",
      "Mantém o PI-Desktop disponível na bandeja do sistema quando minimizado no macOS, Windows e Linux.",
      "Melhora a legibilidade dos menus de seleção nativos nos temas claro e escuro.",
    ]
  },
  {
    "version": "0.5.7",
    "date": "2026-08-12",
    "highlights": [
      "Adiciona perguntas asktool com fluxos de seleção única ou múltipla, respostas personalizadas, opção de pular e recusar.",
      "Mantém visível o progresso de perguntas múltiplas, com indicadores de respostas dadas, pendentes e ignoradas.",
      "Coloca perguntas interativas na mesma área de aprovação do Composer usada pelas aprovações de Plan e Goal.",
      "Simplifica os cartões de aprovação e lembra o modo escolhido para a próxima solicitação.",
    ]
  },
  {
    "version": "0.5.6",
    "date": "2026-08-11",
    "highlights": [
      "Abre plugins instalados pelo lançador global de teclado sem sair do espaço de trabalho atual.",
      "Recolhe os detalhes expandidos de raciocínio, ferramentas e subagentes para facilitar a leitura de conversas longas.",
      "Mantém as configurações de tarefas disponíveis durante turnos ativos e mostra a taxa de processamento após a parada.",
      "Aprimora a hierarquia dos cantos em toda a interface para agrupar elementos visuais com mais clareza.",
    ]
  },
  {
    "version": "0.5.5",
    "date": "2026-08-11",
    "highlights": [
      "Exibe subagentes paralelos e suas relações de tarefas diretamente na conversa.",
      "Mantém compactas as referências a arquivos colados e restaura seus chips após interromper um turno.",
      "Mantém os controles de modo disponíveis durante a criação da sessão e a transcrição fixada após o envio.",
      "Melhora a recuperação quando ferramentas nativas recebem um caminho de arquivo incorreto.",
      "Aprimora as ações no rodapé da barra lateral e os links com quebra de linha nas mensagens do usuário.",
    ]
  },
  {
    "version": "0.5.4",
    "date": "2026-08-08",
    "highlights": [
      "Aprimora o mascote da tela inicial vazia com mudanças de pose mais lentas durante a inatividade e reprodução contínua ao passar o cursor.",
    ]
  },
  {
    "version": "0.5.0",
    "date": "2026-08-07",
    "highlights": [
      "Executa subagentes limitados por uma ferramenta Task, com agentes definidos pelo usuário, modelos fixados, atribuição e persistência de sessão.",
      "Gerencia subagentes em Extensions, com recarga do registro e status somente leitura mais claro.",
      "Prepara e instala pontos de controle de contexto durante períodos de inatividade, preservando o histórico da transcrição e exibindo linhas de compactação e avisos.",
      "Adiciona o modo Goal como segundo modo de contrato e preserva referências a arquivos colados ao usar comandos de modo.",
      "Restaura painéis de subagentes e painéis controlados pelo host quando ele se reconecta, com diagnósticos menos ruidosos para encerramentos rotineiros.",
      "Aprimora o painel de trabalho e as superfícies de extensão com metadados, controles e contraste no tema escuro mais claros.",
    ]
  },
  {
    "version": "0.4.3",
    "date": "2026-08-05",
    "highlights": [
      "Conclui o fluxo do Plan exclusivo do modo Agent, com pontos de controle Markdown persistentes, aprovação e execução em fila.",
      "Adiciona servidores MCP e Skills com escopo de projeto, controlados por uma única opção de escopo em Extensions.",
      "Reforça as permissões de caminhos externos e o escopo da pesquisa nativa em todos os espaços de trabalho.",
      "Fecha as áreas de aprovação do Plan após a resolução e faz com que os comandos de resolução e modo troquem a sessão ativa.",
      "Compacta conversas longas automaticamente: preserva todas as mensagens na transcrição, marca cada compactação e avisa para que você decida se deseja iniciar uma nova sessão.",
    ]
  },
  {
    "version": "0.4.2",
    "date": "2026-08-03",
    "highlights": [
      "Mostra a taxa de acerto do cache de contexto no cabeçalho da transcrição do chat, para maior transparência.",
    ]
  },
  {
    "version": "0.4.1",
    "date": "2026-08-02",
    "highlights": [
      "Atualiza os links do GitHub Releases e do atualizador automático para apontarem ao repositório canônico do PI-Desktop.",
      "Atualiza a documentação do projeto, dos plugins e das versões para usar o nome do repositório PI-Desktop.",
    ]
  },
  {
    "version": "0.4.0",
    "date": "2026-08-01",
    "highlights": [
      "Os plugins agora podem fornecer skills, temas, servidores MCP, serviços residentes e um barramento de mensagens entre plugins.",
      "O SDK de plugins declara todos os novos tipos de capacidade para que os autores possam ativá-los no manifesto.",
      "O núcleo do host valida as contribuições de recursos e determina automaticamente as permissões de cada plugin.",
      "O prompt de sistema do agente agora inclui skills declaradas por plugins, permitindo que as conversas reconheçam as ferramentas disponíveis.",
      "Página Plugins reprojetada com seletor de modelos, recarga a quente ao salvar e ferramentas de autoria.",
      "Criar um plugin a partir de um template agora abre como projeto a pasta gerada pelo scaffolding.",
      "Menu do cabeçalho do painel de trabalho unificado, com controles mais simples e ações contextuais.",
      "Estilos divididos em arquivos parciais por superfície; CSS duplicado e não utilizado removido.",
    ]
  },
  {
    "version": "0.3.0",
    "date": "2026-07-31",
    "highlights": [
      "O arquivo de projetos de Settings agora exibe seções agrupadas (Pinned / All / Archived), com contagem por seção, pesquisa em tempo real e controles de ordenação.",
      "A largura do painel de trabalho encaixado é menor, melhorando as proporções do layout.",
      "Corrige o estilo do trilho do botão de alternância no tema claro.",
    ]
  },
  {
    "version": "0.2.11",
    "date": "2026-07-31",
    "highlights": [
      "A Pesquisa global agora encontra chats, páginas, configurações e comandos integrados ou de plugins em um só lugar.",
      "Os controles de aparência agora usam cartões de pré-visualização de tema e idioma, e o idioma automático acompanha corretamente a localidade do sistema operacional.",
      "Settings agora tem seções dedicadas de IA e atalhos para facilitar a navegação.",
      "O agente agora carrega instruções de projeto AGENTS.md/CLAUDE.md em camadas, com editores para AGENTS.md global e do projeto.",
      "O arquivo de projetos agora pesquisa títulos de sessões e mostra atividades da mais recente para a mais antiga, contagem de sessões, horários e histórico expansível.",
      "Corrige uma falha na inicialização do desktop causada por uma regressão no preload em sandbox.",
      "Reduz em cerca de 55% o tamanho auditado do aplicativo macOS descompactado, mantendo o realce de sintaxe offline e o suporte ao terminal nativo.",
    ]
  },
  {
    "version": "0.2.10",
    "date": "2026-07-30",
    "highlights": [
      "Adiciona uma barra superior de conversa no estilo Codex/WorkBuddy, com controles aprimorados.",
      "Aprimora a transcrição do chat e o estilo da prosa Markdown para facilitar a leitura.",
      "Unifica o cabeçalho do painel de trabalho com o menu de contexto e anima o recolhimento da barra lateral.",
      "Combina os lançadores de ferramentas em um menu suspenso de criação para simplificar a interface.",
      "Encaixa o painel de trabalho na janela fixa, em vez de expandi-la.",
      "Aprimora os controles da barra superior: alternância para remover duplicatas, proteção dos controles e alinhamento no macOS.",
    ]
  },
  {
    "version": "0.2.8",
    "date": "2026-07-29",
    "highlights": [
      "Os avisos de atualização e Settings agora abrem notas de versão completas e localizadas.",
      "As animações de expansão e recolhimento do painel de trabalho estão mais suaves.",
      "Conversas longas compactam lotes grandes de resultados de ferramentas com mais confiabilidade.",
    ]
  },
  {
    "version": "0.2.7",
    "date": "2026-07-28",
    "highlights": [
      "Respostas Markdown podem exibir imagens, áudio e vídeo em linha.",
      "Imagens remotas são exibidas com a política de segurança de conteúdo atualizada.",
      "A marcação de mídia é sanitizada, permitindo somente tags seguras.",
    ]
  },
  {
    "version": "0.2.6",
    "date": "2026-07-28",
    "highlights": [
      "Pontos de controle de contexto no limite de cada turno compactam conversas longas sem ocultar o histórico.",
      "Torna a troca de conversas mais fluida com transcrições em cache e um quadro estável.",
      "As ferramentas encaixadas mantêm largura fixa para que o chat continue legível ao lado do painel de trabalho.",
      "O menu Project pode abrir a pasta no gerenciador de arquivos do sistema.",
      "As linhas de prompt do Composer deixam de exibir um ícone de marca no início.",
    ]
  },
  {
    "version": "0.2.5",
    "date": "2026-07-28",
    "highlights": [
      "Navegação do painel de trabalho reprojetada com um trilho de ferramentas mais claro.",
      "O redimensionamento da janela considera o painel para manter o layout previsível.",
      "As renderizações em streaming são isoladas para interações mais rápidas.",
      "Novas sessões de raciocínio usam por padrão o nível máximo disponível.",
      "Após o envio, a transcrição continua posicionada na mensagem mais recente.",
    ]
  },
  {
    "version": "0.2.4",
    "date": "2026-07-28",
    "highlights": [
      "Os chips do Composer mantêm totalmente visíveis os caracteres descendentes.",
      "Atualiza o pi-ai para modelos Claude mais recentes, incluindo suporte ao Opus 5.",
    ]
  },
  {
    "version": "0.2.3",
    "date": "2026-07-28",
    "highlights": [
      "Textos do Shell reescritos em linguagem simples para usuários em todos os idiomas.",
      "Aprimoramentos na seleção, nos rótulos CJK e na animação ao passar o cursor.",
      "Acabamentos nas superfícies claras do painel de trabalho e de Settings.",
      "Instalações de pré-lançamento agora encontram versões estáveis mais recentes no GitHub Releases.",
    ]
  },
  {
    "version": "0.2.2",
    "date": "2026-07-27",
    "highlights": [
      "Marketplace de plugins com catálogo remoto oficial e painéis de detalhes.",
      "Painéis de plugins isolados e APIs de alto risco sujeitas a controle de acesso.",
      "Permite criar projetos ou sessões clicando com o botão direito nas barras de ferramentas das seções.",
      "Aprimoramentos na tela inicial, na fluidez das animações e na localização (i18n).",
      "A navegação superior do painel de trabalho permite clicar com o botão direito para abrir ferramentas.",
    ]
  },
  {
    "version": "0.2.1",
    "date": "2026-07-27",
    "highlights": [
      "As ferramentas do painel de trabalho são mantidas por conversa.",
      "A entrada de Review fica vinculada à sessão em que as edições foram feitas.",
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-27",
    "highlights": [
      "A barra lateral separa projetos e sessões, com status de tarefa mais claro.",
      "Permite ramificar ou editar respostas do assistente; barras de ferramentas de mensagens usam apenas ícones.",
      "Adiciona acesso à revisão do espaço de trabalho após edições bem-sucedidas em arquivos.",
      "Mapeamentos de atalhos de teclado e modo de desenvolvedor para DevTools.",
      "O catálogo de modelos pi é a referência oficial para modelos de provedores.",
      "O controle de raciocínio fica ao lado do modo no Composer.",
    ]
  },
  {
    "version": "0.1.1",
    "date": "2026-07-26",
    "highlights": [
      "Primeiro lançamento público: cliente desktop de agente de programação com IA, com foco no uso local.",
      "Modos Chat e Agent com respostas em streaming, níveis de raciocínio e gerenciamento de modelos.",
      "Ferramentas de espaço de trabalho com controle de permissões, terminal, navegador e revisão do Git.",
      "Núcleo do host em Rust para armazenamento, segredos, sessões e notificações.",
      "Base para plugins e interface bilíngue em inglês / 简体中文.",
      "Verifica atualizações no GitHub Releases (no aplicativo quando houver suporte).",
    ]
  }
];
