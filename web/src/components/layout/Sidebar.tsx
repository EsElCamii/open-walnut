import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { NotificationPanel } from '@/components/common/NotificationPanel';

const SS_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';
const SS_TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible';

interface SidebarProps {
  open: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ open, collapsed, onToggleCollapse }: SidebarProps) {
  const cls = `sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`;
  const { hasIssues } = useSystemHealth();
  const [notifOpen, setNotifOpen] = useState(false);

  // Panel visibility state — synced from MainPage via custom events
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CHAT_VISIBLE_KEY) !== 'false'
  );
  const [todoVisible, setTodoVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_TODO_VISIBLE_KEY) !== 'false'
  );

  useEffect(() => {
    const handleChatVisible = (e: Event) => {
      setChatVisible((e as CustomEvent).detail?.visible ?? true);
    };
    const handleTodoVisible = (e: Event) => {
      setTodoVisible((e as CustomEvent).detail?.visible ?? true);
    };
    window.addEventListener('main:chat-visible', handleChatVisible);
    window.addEventListener('main:todo-visible', handleTodoVisible);
    return () => {
      window.removeEventListener('main:chat-visible', handleChatVisible);
      window.removeEventListener('main:todo-visible', handleTodoVisible);
    };
  }, []);

  const handleToggleChat = () => {
    window.dispatchEvent(new CustomEvent('dock:activate-chat'));
  };
  const handleToggleTodo = () => {
    window.dispatchEvent(new CustomEvent('sidebar:toggle-todo'));
  };

  return (
    <aside className={cls}>
      <div className="sidebar-header">
        <button
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <HamburgerIcon />
        </button>
        <span className="sidebar-label">
          <WalnutIcon /> Walnut
        </span>
      </div>
      <nav className="sidebar-nav">
        {/* Panel toggle buttons */}
        <button
          className={`sidebar-link sidebar-panel-toggle${chatVisible ? ' active' : ''}`}
          onClick={handleToggleChat}
          title={collapsed ? 'Chat' : undefined}
        >
          <ChatBubbleIcon />
          <span className="sidebar-label">Chat</span>
        </button>
        <button
          className={`sidebar-link sidebar-panel-toggle${todoVisible ? ' active' : ''}`}
          onClick={handleToggleTodo}
          title={collapsed ? 'Todo' : undefined}
        >
          <TodoListIcon />
          <span className="sidebar-label">Todo</span>
        </button>
        <div className="sidebar-nav-divider" />
        <NavLink to="/" end className={navLinkClass} title={collapsed ? 'Home' : undefined}>
          <HomeIcon />
          <span className="sidebar-label">Home</span>
        </NavLink>
        <NavLink to="/tasks" className={navLinkClass} title={collapsed ? 'Tasks' : undefined}>
          <TasksIcon />
          <span className="sidebar-label">Tasks</span>
        </NavLink>
        <NavLink to="/search" className={navLinkClass} title={collapsed ? 'Search' : undefined}>
          <SearchIcon />
          <span className="sidebar-label">Search</span>
        </NavLink>
        <NavLink to="/sessions" className={navLinkClass} title={collapsed ? 'Sessions' : undefined}>
          <SessionsIcon />
          <span className="sidebar-label">Sessions</span>
        </NavLink>
        <NavLink to="/memory" className={navLinkClass} title={collapsed ? 'Memory' : undefined}>
          <MemoryIcon />
          <span className="sidebar-label">Memory</span>
        </NavLink>
        <NavLink to="/notes" className={navLinkClass} title={collapsed ? 'Notes' : undefined}>
          <NotesIcon />
          <span className="sidebar-label">Notes</span>
        </NavLink>
        <NavLink to="/repos" className={navLinkClass} title={collapsed ? 'Repos' : undefined}>
          <ReposIcon />
          <span className="sidebar-label">Repos</span>
        </NavLink>
        <NavLink to="/cron" className={navLinkClass} title={collapsed ? 'Scheduled' : undefined}>
          <ScheduleIcon />
          <span className="sidebar-label">Scheduled</span>
        </NavLink>
        <NavLink to="/usage" className={navLinkClass} title={collapsed ? 'Usage' : undefined}>
          <UsageIcon />
          <span className="sidebar-label">Usage</span>
        </NavLink>
        <NavLink to="/agents" className={navLinkClass} title={collapsed ? 'Agents' : undefined}>
          <AgentsIcon />
          <span className="sidebar-label">Agents</span>
        </NavLink>
        <NavLink to="/skills" className={navLinkClass} title={collapsed ? 'Skills' : undefined}>
          <SkillsIcon />
          <span className="sidebar-label">Skills</span>
        </NavLink>
        <NavLink to="/commands" className={navLinkClass} title={collapsed ? 'Commands' : undefined}>
          <CommandsIcon />
          <span className="sidebar-label">Commands</span>
        </NavLink>
        <NavLink to="/hooks" className={navLinkClass} title={collapsed ? 'Hooks' : undefined}>
          <HooksIcon />
          <span className="sidebar-label">Hooks</span>
        </NavLink>
        <NavLink to="/timeline" className={navLinkClass} title={collapsed ? 'Timeline' : undefined}>
          <TimelineIcon />
          <span className="sidebar-label">Timeline</span>
        </NavLink>
        <NavLink to="/settings" className={navLinkClass} title={collapsed ? 'Settings' : undefined}>
          <SettingsIcon />
          <span className="sidebar-label">Settings</span>
        </NavLink>
      </nav>

      {/* Notification bell — between nav and stats */}
      <div className="sidebar-notification-area">
        <button
          className="sidebar-link sidebar-notification-btn"
          onClick={() => setNotifOpen(!notifOpen)}
          title={collapsed ? 'Notifications' : undefined}
          aria-label="Notifications"
        >
          <BellIcon />
          <span className="sidebar-label">Notifications</span>
          {hasIssues && <span className="notification-badge-dot" />}
        </button>
      </div>

      <div className="sidebar-stats">
        <div className="sidebar-stat">
          <span>Tasks</span>
          <span className="sidebar-stat-value" id="stat-tasks">--</span>
        </div>
        <div className="sidebar-stat">
          <span>Active</span>
          <span className="sidebar-stat-value" id="stat-active">--</span>
        </div>
      </div>

      <NotificationPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        sidebarCollapsed={collapsed}
      />
    </aside>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `sidebar-link${isActive ? ' active' : ''}`;
}

/* Inline SVG icons */

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SessionsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ScheduleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 1 0-16 0" />
      <line x1="12" y1="12" x2="12" y2="16" />
      <circle cx="12" cy="18" r="2" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function CommandsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function HooksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function TimelineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="18" r="2" />
      <line x1="14" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="10" y2="12" />
      <line x1="14" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ReposIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <polyline points="9 14 12 11 15 14" />
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function WalnutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" className="sidebar-open-walnut-icon">
      <ellipse cx="11.5" cy="12" rx="7.5" ry="8.5" fill="currentColor" />
      <ellipse cx="12.5" cy="12" rx="7.5" ry="8.5" fill="currentColor" />
      <line x1="12" y1="3.5" x2="12" y2="20.5" stroke="var(--bg-secondary)" strokeWidth="1.5" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TodoListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

