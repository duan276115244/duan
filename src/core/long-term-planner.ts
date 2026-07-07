/**
 * 段先生 - 长期规划与执行系统
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson } from './atomic-write.js';

interface Goal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  deadline?: Date;
  createdAt: Date;
  completedAt?: Date;
  progress: number;
  milestones: Milestone[];
  tasks: Task[];
  subgoals: Goal[];
}

interface Milestone {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: Date;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  assignedTo?: string;
  dueDate?: Date;
  completedAt?: Date;
  dependencies?: string[];
}

interface Project {
  id: string;
  title: string;
  description: string;
  goals: Goal[];
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'completed' | 'archived';
}

export class LongTermPlanner {
  private projects: Project[] = [];
  private dbPath: string;

  constructor(dbPath: string = './data/planner.json') {
    this.dbPath = dbPath;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      this.projects = JSON.parse(data);
    } catch {
      this.projects = [];
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteJson(this.dbPath, this.projects);
    } catch (error: unknown) {
      console.error('保存规划失败:', error);
    }
  }

  async createProject(title: string, description: string): Promise<string> {
    const project: Project = {
      id: `proj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      description,
      goals: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'active',
    };

    this.projects.push(project);
    await this.save();

    return `项目 "${title}" 已创建 (ID: ${project.id})`;
  }

  async addGoal(projectId: string, title: string, description: string, priority: 'high' | 'medium' | 'low' = 'medium'): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) {
      return `项目 ${projectId} 不存在`;
    }

    const goal: Goal = {
      id: `goal_${Date.now()}`,
      title,
      description,
      status: 'active',
      priority,
      createdAt: new Date(),
      progress: 0,
      milestones: [],
      tasks: [],
      subgoals: [],
    };

    project.goals.push(goal);
    project.updatedAt = new Date();
    await this.save();

    return `目标 "${title}" 已添加到项目 "${project.title}"`;
  }

  async addMilestone(goalId: string, title: string): Promise<string> {
    for (const project of this.projects) {
      const goal = project.goals.find(g => g.id === goalId);
      if (goal) {
        goal.milestones.push({
          id: `ms_${Date.now()}`,
          title,
          completed: false,
        });
        project.updatedAt = new Date();
        await this.save();
        return `里程碑 "${title}" 已添加`;
      }
    }
    return `目标 ${goalId} 不存在`;
  }

  async addTask(goalId: string, title: string, description?: string, dependencies?: string[]): Promise<string> {
    for (const project of this.projects) {
      const goal = project.goals.find(g => g.id === goalId);
      if (goal) {
        goal.tasks.push({
          id: `task_${Date.now()}`,
          title,
          description,
          status: 'pending',
          dependencies,
        });
        this.updateProgress(goal);
        project.updatedAt = new Date();
        await this.save();
        return `任务 "${title}" 已添加`;
      }
    }
    return `目标 ${goalId} 不存在`;
  }

  async completeTask(taskId: string): Promise<string> {
    for (const project of this.projects) {
      for (const goal of project.goals) {
        const task = goal.tasks.find(t => t.id === taskId);
        if (task) {
          task.status = 'completed';
          task.completedAt = new Date();
          this.updateProgress(goal);
          project.updatedAt = new Date();
          await this.save();
          return `任务 "${task.title}" 已完成`;
        }
      }
    }
    return `任务 ${taskId} 不存在`;
  }

  private updateProgress(goal: Goal): void {
    if (goal.tasks.length === 0) {
      goal.progress = goal.milestones.filter(m => m.completed).length / 
        (goal.milestones.length || 1) * 100;
    } else {
      const completedTasks = goal.tasks.filter(t => t.status === 'completed').length;
      goal.progress = (completedTasks / goal.tasks.length) * 100;
    }

    if (goal.progress >= 100) {
      goal.status = 'completed';
      goal.completedAt = new Date();
    }
  }

  getProjectStatus(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) {
      return Promise.resolve(`项目 ${projectId} 不存在`);
    }

    const status = `
📊 项目状态: ${project.title}

📝 描述: ${project.description}
📅 创建时间: ${project.createdAt.toLocaleDateString()}
🔄 状态: ${project.status}

🎯 目标 (${project.goals.length}):
${project.goals.map(g => `
  【${g.title}】
  优先级: ${g.priority}
  进度: ${g.progress.toFixed(1)}%
  状态: ${g.status}
  任务: ${g.tasks.filter(t => t.status === 'completed').length}/${g.tasks.length}
`).join('')}
    `.trim();

    return Promise.resolve(status);
  }

  listProjects(): Promise<string> {
    if (this.projects.length === 0) {
      return Promise.resolve('暂无项目');
    }

    return Promise.resolve(this.projects.map(p => {
      const totalTasks = p.goals.reduce((sum, g) => sum + g.tasks.length, 0);
      const completedTasks = p.goals.reduce(
        (sum, g) => sum + g.tasks.filter(t => t.status === 'completed').length, 
        0
      );
      const progress = totalTasks > 0 ? (completedTasks / totalTasks * 100).toFixed(1) : '0';

      return `📁 ${p.title} (${p.status})
   进度: ${progress}%
   目标: ${p.goals.length} | 任务: ${completedTasks}/${totalTasks}`;
    }).join('\n\n'));
  }

  getUpcomingTasks(days: number = 7): Promise<string> {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const upcomingTasks: { task: Task; project: string; goal: string; dueDate?: Date }[] = [];

    for (const project of this.projects) {
      for (const goal of project.goals) {
        for (const task of goal.tasks) {
          if (task.status !== 'completed' && task.dueDate) {
            const dueDate = new Date(task.dueDate);
            if (dueDate >= now && dueDate <= future) {
              upcomingTasks.push({
                task,
                project: project.title,
                goal: goal.title,
                dueDate,
              });
            }
          }
        }
      }
    }

    if (upcomingTasks.length === 0) {
      return Promise.resolve(`未来 ${days} 天内没有待办任务`);
    }

    return Promise.resolve(upcomingTasks
      .sort((a, b) => (a.dueDate?.getTime() || 0) - (b.dueDate?.getTime() || 0))
      .map(t => `📋 ${t.task.title}
   项目: ${t.project}
   目标: ${t.goal}
   截止: ${t.dueDate?.toLocaleDateString()}`)
      .join('\n\n'));
  }

  analyzeProgress(): Promise<string> {
    const totalProjects = this.projects.length;
    const activeProjects = this.projects.filter(p => p.status === 'active').length;
    const completedProjects = this.projects.filter(p => p.status === 'completed').length;

    const allGoals = this.projects.flatMap(p => p.goals);
    const totalGoals = allGoals.length;
    const completedGoals = allGoals.filter(g => g.status === 'completed').length;

    const allTasks = allGoals.flatMap(g => g.tasks);
    const totalTasks = allTasks.length;
    const completedTasks = allTasks.filter(t => t.status === 'completed').length;

    const overdueTasks = allTasks.filter(t => {
      if (t.status === 'completed' || !t.dueDate) return Promise.resolve(false);
      return Promise.resolve(new Date(t.dueDate) < new Date());
    });

    const analysis = `
📊 整体进展分析

项目: ${completedProjects}/${totalProjects} 完成 (${activeProjects} 进行中)
目标: ${completedGoals}/${totalGoals} 完成
任务: ${completedTasks}/${totalTasks} 完成 (${(totalTasks > 0 ? completedTasks / totalTasks * 100 : 0).toFixed(1)}%)

⚠️ 逾期任务: ${overdueTasks.length}
${overdueTasks.length > 0 ? overdueTasks.map(t => `- ${t.title}`).join('\n') : ''}

📈 效率指标:
- 项目完成率: ${(completedProjects / totalProjects * 100 || 0).toFixed(1)}%
- 目标完成率: ${(completedGoals / totalGoals * 100 || 0).toFixed(1)}%
- 任务完成率: ${(completedTasks / totalTasks * 100 || 0).toFixed(1)}%
    `.trim();

    return Promise.resolve(analysis);
  }

  async archiveProject(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) {
      return `项目 ${projectId} 不存在`;
    }

    project.status = 'archived';
    await this.save();

    return `项目 "${project.title}" 已归档`;
  }

  async getDashboard(): Promise<string> {
    const analysis = await this.analyzeProgress();
    const projects = await this.listProjects();
    const upcoming = await this.getUpcomingTasks(3);

    return `
🎯 段先生规划仪表盘

${'='.repeat(50)}
${analysis}
${'='.repeat(50)}

📁 项目列表:
${projects}

📅 近期任务 (3天内):
${upcoming}
    `.trim();
  }
}
