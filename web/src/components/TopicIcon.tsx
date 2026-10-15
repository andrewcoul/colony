import {
  Baby, BookOpen, Briefcase, CalendarDays, Camera, Car, Code, Dumbbell, Gift, Globe, GraduationCap, Hammer, Heart, House, Leaf,
  MessageCircle, Music, PawPrint, Plane, Receipt, ShoppingCart, Sparkles, Users, Utensils, Wallet, type LucideIcon,
} from "lucide-react";
import type { TopicIcon as TopicIconKey } from "@shared/types";
import { cn } from "../lib/utils";

/** The drawing behind each topic icon key (the server only stores the key). */
export const TOPIC_GLYPHS: Record<TopicIconKey, LucideIcon> = {
  chat: MessageCircle, cart: ShoppingCart, home: House, hammer: Hammer, receipt: Receipt, plane: Plane, heart: Heart,
  calendar: CalendarDays, briefcase: Briefcase, book: BookOpen, sparkles: Sparkles, users: Users, globe: Globe, wallet: Wallet,
  car: Car, gift: Gift, utensils: Utensils, dumbbell: Dumbbell, baby: Baby, graduation: GraduationCap, music: Music,
  camera: Camera, code: Code, leaf: Leaf, paw: PawPrint,
};

/** The rounded tile a topic wears in lists and its header. */
export function TopicTile({ icon, size = 24, active, className }: { icon: TopicIconKey | null; size?: number; active?: boolean; className?: string }) {
  const Glyph = TOPIC_GLYPHS[icon ?? "chat"] ?? MessageCircle;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center transition-colors", active ? "bg-peach/16 text-peach" : "bg-raised text-soft", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29) }}
      aria-hidden="true"
    >
      <Glyph size={Math.round(size * 0.56)} strokeWidth={1.9} />
    </span>
  );
}
