import { Container, Spacer, Text } from '@mariozechner/pi-tui';
import packageJson from '../../package.json';
import { theme } from '../theme.js';
import { getModelDisplayName } from '../utils/model.js';
import { isDeferredCommand } from '../scan/octagon-capabilities.js';

const INTRO_WIDTH = 60;

export class IntroComponent extends Container {
  private readonly modelText: Text;

  constructor(model: string) {
    super();

    const isDemo = process.env.POLYMARKET_USE_DEMO === 'true';
    const welcomeText = isDemo ? 'Polymarket Trading Bot CLI  [DEMO MODE]' : 'Polymarket Trading Bot CLI';
    const versionText = ` v${packageJson.version}`;
    const fullText = welcomeText + versionText;
    const padding = Math.max(0, Math.floor((INTRO_WIDTH - fullText.length - 2) / 2));
    const trailing = Math.max(0, INTRO_WIDTH - fullText.length - padding - 2);

    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.primary('═'.repeat(INTRO_WIDTH)), 0, 0));
    this.addChild(
      new Text(
        theme.primary(
          `║${' '.repeat(padding)}${theme.bold(welcomeText)}${theme.muted(versionText)}${' '.repeat(
            trailing,
          )}║`,
        ),
        0,
        0,
      ),
    );
    this.addChild(new Text(theme.primary('═'.repeat(INTRO_WIDTH)), 0, 0));
    this.addChild(new Spacer(1));

    this.addChild(
      new Text(
        theme.bold(
          theme.primary(
            `
 ██████╗  ██████╗████████╗ █████╗  ██████╗  ██████╗ ███╗   ██╗
██╔═══██╗██╔════╝╚══██╔══╝██╔══██╗██╔════╝ ██╔═══██╗████╗  ██║
██║   ██║██║        ██║   ███████║██║  ███╗██║   ██║██╔██╗ ██║
██║   ██║██║        ██║   ██╔══██║██║   ██║██║   ██║██║╚██╗██║
╚██████╔╝╚██████╗   ██║   ██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║
 ╚═════╝  ╚═════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝`,
          ),
        ),
        0,
        0,
      ),
    );

    if (isDemo) {
      this.addChild(new Spacer(1));
      this.addChild(
        new Text(
          theme.warning('  ⚠  DEMO MODE — orders are simulated, no real money at risk  ⚠'),
          0,
          0,
        ),
      );
    }

    this.addChild(new Spacer(1));
    this.addChild(new Text('AI-powered prediction market terminal.', 0, 0));
    this.addChild(new Spacer(1));
    const cmd = (label: string) => theme.muted(label.padEnd(11));
    // Single list so the intro cannot drift from autocomplete; entries whose
    // command is gated by octagon-capabilities are filtered out.
    const commandRows: Array<[string, string]> = [
      ['/search', 'Search events by theme, ticker, or free-text; /search edge for edge scan'],
      ['/similar', '<ticker|"text">  Semantic neighbors (Octagon embeddings)'],
      ['/clusters', '[--ranked|--behavioral]  Browse thematic & behavioral clusters'],
      ['/peers', '<ticker>  Markets in the same cluster'],
      ['/events', '[ticker]  Octagon events + outcome ladder'],
      ['/trust', '<event_ticker>  Trader Trust scorecard (per-market integrity)'],
      ['/report', '<event_ticker>  Full Octagon markdown report (--refresh for fresh)'],
      ['/series', '[ticker]  Series rollup; /series candles <SERIES> for NAV'],
      ['/themes', 'list|show|report|audit|overlap  Editorial narrative registry'],
      ['/catalysts', 'upcoming --days N  Markets closing soon, grouped by week'],
      ['/correlate', '<t1> <t2> [...]  Pairwise correlation matrix'],
      ['/basket', 'build|backtest|size|candles|validate  Diversified basket tools'],
      ['/portfolio', 'Overview, positions, value, status'],
      ['/analyze', '<ticker>  Full analysis: edge, research, Kelly sizing'],
      ['/watch', '<ticker>  Live price/orderbook feed'],
      ['/backtest', 'Model accuracy scorecard + live edge scanner'],
      ['/buy /sell', '<ticker> <n> [price]   /cancel <order_id>'],
      ['/help', '[command]  Show help (/help <command> for details)'],
      ['/quit', 'Quit CLI session'],
    ];
    for (const [name, desc] of commandRows) {
      const bare = name.split(' ')[0]!.replace(/^\//, '');
      if (isDeferredCommand(bare)) continue;
      // Order placement is not implemented yet — don't advertise it.
      if (bare === 'buy' || bare === 'sell' || bare === 'cancel') continue;
      this.addChild(new Text(cmd(name) + desc, 0, 0));
    }
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.muted('Ask anything: ') + '"analyze world-cup-winner"  "search crypto"  "show my portfolio"', 0, 0));
    this.modelText = new Text('', 0, 0);
    this.addChild(this.modelText);
    this.setModel(model);
  }

  setModel(model: string) {
    this.modelText.setText(
      `${theme.muted('Model: ')}${theme.primary(getModelDisplayName(model))}${theme.muted(
        '. Type /model to change.',
      )}`,
    );
  }
}
