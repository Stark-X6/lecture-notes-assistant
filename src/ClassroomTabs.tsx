import {
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { BookOpen, Clock3, FileText, Layers } from "lucide-react";

const pages = [
  { id: "slides", label: "课件", icon: Layers },
  { id: "book", label: "教材", icon: BookOpen },
  { id: "notes", label: "笔记", icon: FileText },
  { id: "transcript", label: "转录", icon: Clock3 },
] as const;

export type ClassroomTab = (typeof pages)[number]["id"];

export function ClassroomTabs({
  active,
  onChange,
}: {
  active: ClassroomTab;
  onChange: (page: ClassroomTab) => void;
}) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + pages.length - 1) % pages.length;
        break;
      case "ArrowRight":
        next = (index + 1) % pages.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = pages.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(pages[next].id);
    document.getElementById("classroom-tab-" + pages[next].id)?.focus();
  }
  return (
    <div className="classroom-tabs" role="tablist" aria-label="课堂页面">
      {pages.map(({ id, label, icon: Icon }, index) => (
        <button
          key={id}
          id={"classroom-tab-" + id}
          role="tab"
          aria-selected={active === id}
          aria-controls={"classroom-page-" + id}
          tabIndex={active === id ? 0 : -1}
          onKeyDown={(event) => navigate(event, index)}
          onClick={() => onChange(id)}
        >
          <Icon aria-hidden="true" size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function ClassroomPage({
  name,
  active,
  children,
}: {
  name: ClassroomTab;
  active: ClassroomTab;
  children: () => ReactNode;
}) {
  const visible = active === name;
  const [visited, setVisited] = useState(visible);
  useLayoutEffect(() => {
    if (visible) setVisited(true);
  }, [visible]);
  return (
    <div
      id={"classroom-page-" + name}
      className="classroom-page"
      role="tabpanel"
      aria-labelledby={"classroom-tab-" + name}
      hidden={!visible}
      tabIndex={0}
    >
      {(visible || visited) && children()}
    </div>
  );
}
