export interface InventoryItem {
  code: string;
  name: string;
  stock: number;
}

export interface BotConfig {
  token: string;
  adminId: string;
  groupId?: string;
  customerMessage?: string;
  groupAccess?: 'all' | 'admin' | 'group_admins';
  botEnabled?: boolean;
  disableCustomerPm?: boolean;
  userbotApiId?: string;
  userbotApiHash?: string;
  userbotSession?: string;
  userbotEnabled?: boolean;
  userbotGroups?: string;
}

export interface CustomerRequest {
  userId: string;
  username: string;
  chatId: string;
  chatTitle: string;
  itemCode: string;
  itemName: string;
  date: string;
}

export interface DetectedGroup {
  id: string;
  title: string;
  username?: string;
  lastActive: string;
}

export interface AppState {
  config: BotConfig;
  inventory: InventoryItem[];
  customers: CustomerRequest[];
  isRunning: boolean;
  groups?: DetectedGroup[];
}

