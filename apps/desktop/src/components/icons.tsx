import type { CSSProperties, SVGProps } from "react";
import {
  Activity,
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  AtSign,
  Bell,
  BookOpen,
  Bot,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ClipboardPaste,
  Clock,
  CloudDownload,
  Code2,
  Download,
  Copy,
  Dot,
  ExternalLink,
  FileDiff,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Globe2,
  GitFork,
  GitPullRequestArrow,
  Image,
  Info,
  Keyboard,
  KeyRound,
  Link,
  ListChecks,
  LogOut,
  Mic,
  Minus,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  MoreHorizontal,
  Music,
  Palette,
  PanelLeft,
  PanelRight,
  PanelRightOpen,
  PawPrint,
  PencilLine,
  Pin,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCcw,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  Slash,
  Smile,
  Sparkles,
  Square,
  Star,
  Sun,
  Target,
  Terminal,
  Trash2,
  TriangleAlert,
  UserRound,
  Undo2,
  Video,
  Webhook,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = LucideProps;

/**
 * Lucide sizes are fixed px attributes. Multiply them by `--font-scale` so
 * chrome glyphs stay in proportion with the Appearance type scale (D343).
 */
function scaledIconBox(size: IconProps["size"] = 16): string {
  if (typeof size === "number" && Number.isFinite(size)) {
    return `calc(${size}px * var(--font-scale))`;
  }
  if (typeof size === "string" && size.trim()) {
    const value = size.trim();
    return /[a-z%]+$/i.test(value)
      ? `calc(${value} * var(--font-scale))`
      : `calc(${value}px * var(--font-scale))`;
  }
  return "calc(16px * var(--font-scale))";
}

function withScaledIconStyle(
  size: IconProps["size"],
  style?: CSSProperties,
): CSSProperties {
  const box = scaledIconBox(size);
  return { width: box, height: box, ...style };
}

/* Defaults (16px, 1.75 stroke) match the app's previous hand-drawn icon set. */
function icon(Lucide: LucideIcon) {
  return function Icon({ size = 16, style, ...props }: IconProps) {
    return (
      <Lucide
        size={size}
        strokeWidth={1.75}
        {...props}
        style={withScaledIconStyle(size, style)}
      />
    );
  };
}

export const IconPlus = icon(Plus);
export const IconPower = icon(Power);
export const IconPlay = icon(Play);
export const IconBookOpen = icon(BookOpen);
/** Paste-from-clipboard actions (MCP config import). */
export const IconClipboard = icon(ClipboardPaste);
export const IconArchive = icon(Archive);
export const IconArchiveRestore = icon(ArchiveRestore);
export const IconActivity = icon(Activity);
export const IconArrowUpDown = icon(ArrowUpDown);
export const IconSearch = icon(Search);
export const IconRefresh = icon(RefreshCcw);
export const IconChat = icon(MessageSquare);
/** Session creation affordance. Keep it distinct from generic add actions. */
export const IconNewSession = icon(MessageSquarePlus);
export const IconFolder = icon(Folder);
export const IconFolderOpen = icon(FolderOpen);
export const IconNewProject = icon(FolderPlus);
export const IconGripVertical = icon(GripVertical);
export const IconFileText = icon(FileText);
export const IconGlobe = icon(Globe2);
export const IconBranch = icon(GitFork);
export const IconTerminal = icon(Terminal);
export const IconPencil = icon(PencilLine);
export const IconWrench = icon(Wrench);
export const IconPullRequest = icon(GitPullRequestArrow);
export const IconClock = icon(Clock);
export const IconAt = icon(AtSign);
export const IconSettings = icon(Settings);
export const IconHelp = icon(CircleHelp);
export const IconPanel = icon(PanelRight);
export const IconPanelOpen = icon(PanelRightOpen);
export const IconDiff = icon(FileDiff);
export const IconSidebar = icon(PanelLeft);
export const IconArrowUp = icon(ArrowUp);
export const IconArrowDown = icon(ArrowDown);
export const IconCopy = icon(Copy);
export const IconCode = icon(Code2);
export const IconCheck = icon(Check);
export const IconBell = icon(Bell);
export const IconBot = icon(Bot);
export const IconCheckCheck = icon(CheckCheck);
export const IconShield = icon(Shield);
export const IconChevronDown = icon(ChevronDown);
export const IconClose = icon(X);
/* Frameless window chrome (WindowControls): minimize / maximize / restore. */
export const IconMinus = icon(Minus);
export const IconSquare = icon(Square);
export const IconSliders = icon(SlidersHorizontal);
export const IconConfig = icon(RefreshCcw);
export const IconChevronLeft = icon(ChevronLeft);
export const IconChevronRight = icon(ChevronRight);
export const IconExternal = icon(ExternalLink);
export const IconArrowUpRight = icon(ArrowUpRight);
export const IconUndo2 = icon(Undo2);
export const IconCloudDown = icon(CloudDownload);
export const IconDownload = icon(Download);
export const IconImage = icon(Image);
export const IconCamera = icon(Camera);
/* Composer attachment chips: one glyph per file family. */
export const IconSheet = icon(FileSpreadsheet);
export const IconAudio = icon(Music);
export const IconVideo = icon(Video);
export const IconReview = icon(RefreshCw);
export const IconKeyboard = icon(Keyboard);
export const IconMic = icon(Mic);
export const IconPlug = icon(Plug);
export const IconSlash = icon(Slash);
export const IconUser = icon(UserRound);
/** A signed-in vendor account, as opposed to a pasted key. */
export const IconKey = icon(KeyRound);
export const IconLogOut = icon(LogOut);
export const IconSparkles = icon(Sparkles);
export const IconListChecks = icon(ListChecks);
/** Goal mode: an outcome to reach, as opposed to Plan's list of steps. */
export const IconTarget = icon(Target);
export const IconBrowser = icon(AppWindow);
export const IconHook = icon(Webhook);
export const IconWorkflow = icon(Workflow);
export const IconLink = icon(Link);
export const IconPalette = icon(Palette);
export const IconPerson = icon(Smile);
export const IconInfo = icon(Info);
export const IconServer = icon(Server);
export const IconSun = icon(Sun);
export const IconMoon = icon(Moon);
export const IconMonitor = icon(Monitor);
export const IconPet = icon(PawPrint);
export const IconSnapshot = icon(RotateCw);
export const IconGear = icon(Settings);
export const IconPin = icon(Pin);
export const IconMore = icon(MoreHorizontal);
export const IconX = icon(X);
export const IconTrash = icon(Trash2);
export const IconStar = icon(Star);
/* Toast status glyphs (see ToastHost) */
export const IconCircleCheck = icon(CircleCheck);
export const IconCircleAlert = icon(CircleAlert);
export const IconTriangleAlert = icon(TriangleAlert);

export function IconStop({ size = 16, style, ...props }: IconProps) {
  return (
    <Square
      size={size}
      strokeWidth={0}
      fill="currentColor"
      {...props}
      style={withScaledIconStyle(size, style)}
    />
  );
}

/* Heavy round-capped stroke renders Lucide's Dot at the old filled-dot size. */
export function IconDot({ size = 16, style, ...props }: IconProps) {
  return (
    <Dot
      size={size}
      strokeWidth={6.5}
      {...props}
      style={withScaledIconStyle(size, style)}
    />
  );
}

/** VS Code brand mark (settings open-target pill) — logos stay custom, no Lucide equivalent. */
export function IconVSCode(props: SVGProps<SVGSVGElement> & { size?: number }) {
  const { size = 14, style, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...rest}
      style={withScaledIconStyle(size, style)}
    >
      <path
        d="M17.5 2.6 21 4.2v15.6l-3.5 1.6-9.2-7.2L3 17V7l5.3-2.8 9.2 7.2V2.6Z"
        fill="#0078D4"
      />
      <path
        d="M17.5 2.6v11.4L8.3 7.2 17.5 2.6Z"
        fill="#0090F1"
        opacity="0.92"
      />
      <path
        d="M8.3 16.8 17.5 21.4V10.6L8.3 16.8Z"
        fill="#0065A9"
        opacity="0.95"
      />
    </svg>
  );
}
