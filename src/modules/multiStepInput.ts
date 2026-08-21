import * as vscode from 'vscode';

// The standard VS Code "multi-step input" pattern (as used in Microsoft's own
// extension samples): a chain of step functions, each returning the next step
// (or nothing to finish). Back/Escape are implemented as exceptions caught by
// the runner, so an individual step never has to know its position in the chain.
class InputFlowAction {
  static back = new InputFlowAction();
  static cancel = new InputFlowAction();
}

export type InputStep = (input: MultiStepInput) => Promise<InputStep | void>;

export interface QuickPickParameters<T extends vscode.QuickPickItem> {
  title: string;
  step: number;
  totalSteps: number;
  items: T[];
  activeItem?: T;
  placeholder: string;
}

export interface QuickPickManyParameters<T extends vscode.QuickPickItem> {
  title: string;
  step: number;
  totalSteps: number;
  items: T[];
  selectedItems?: T[];
  placeholder: string;
}

export interface InputBoxParameters {
  title: string;
  step: number;
  totalSteps: number;
  value: string;
  prompt: string;
  placeholder?: string;
  password?: boolean;
  validate: (value: string) => string | undefined | Promise<string | undefined>;
}

export class MultiStepInput {
  static async run(start: InputStep): Promise<boolean> {
    const input = new MultiStepInput();
    return input.stepThrough(start);
  }

  private current?: vscode.QuickInput;
  private steps: InputStep[] = [];

  private async stepThrough(start: InputStep): Promise<boolean> {
    let step: InputStep | void = start;
    while (step) {
      this.steps.push(step);
      if (this.current) {
        this.current.enabled = false;
        this.current.busy = true;
      }
      try {
        step = await step(this);
      } catch (err) {
        if (err === InputFlowAction.back) {
          this.steps.pop();
          step = this.steps.pop();
        } else if (err === InputFlowAction.cancel) {
          if (this.current) {
            this.current.dispose();
          }
          return false;
        } else {
          throw err;
        }
      }
    }
    if (this.current) {
      this.current.dispose();
    }
    return true;
  }

  private backButtons(): vscode.QuickInputButton[] {
    return this.steps.length > 1 ? [vscode.QuickInputButtons.Back] : [];
  }

  async showQuickPick<T extends vscode.QuickPickItem>(params: QuickPickParameters<T>): Promise<T> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<T>((resolve, reject) => {
        const input = vscode.window.createQuickPick<T>();
        input.title = params.title;
        input.step = params.step;
        input.totalSteps = params.totalSteps;
        input.placeholder = params.placeholder;
        input.ignoreFocusOut = true;
        input.items = params.items;
        if (params.activeItem) {
          input.activeItems = [params.activeItem];
        }
        input.buttons = this.backButtons();
        disposables.push(
          input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            }
          }),
          input.onDidChangeSelection(items => resolve(items[0])),
          input.onDidHide(() => reject(InputFlowAction.cancel))
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  async showQuickPickMany<T extends vscode.QuickPickItem>(
    params: QuickPickManyParameters<T>
  ): Promise<T[]> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const input = vscode.window.createQuickPick<T>();
        input.title = params.title;
        input.step = params.step;
        input.totalSteps = params.totalSteps;
        input.placeholder = params.placeholder;
        input.ignoreFocusOut = true;
        input.canSelectMany = true;
        input.items = params.items;
        if (params.selectedItems) {
          input.selectedItems = params.selectedItems;
        }
        input.buttons = this.backButtons();
        disposables.push(
          input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            }
          }),
          input.onDidAccept(() => resolve([...input.selectedItems])),
          input.onDidHide(() => reject(InputFlowAction.cancel))
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  async showInputBox(params: InputBoxParameters): Promise<string> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<string>((resolve, reject) => {
        const input = vscode.window.createInputBox();
        input.title = params.title;
        input.step = params.step;
        input.totalSteps = params.totalSteps;
        input.value = params.value || '';
        input.prompt = params.prompt;
        input.placeholder = params.placeholder;
        input.password = !!params.password;
        input.ignoreFocusOut = true;
        input.buttons = this.backButtons();

        let validating = Promise.resolve<string | undefined>(undefined);
        disposables.push(
          input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            }
          }),
          input.onDidAccept(async () => {
            const value = input.value;
            input.enabled = false;
            input.busy = true;
            const error = await params.validate(value);
            input.enabled = true;
            input.busy = false;
            if (!error) {
              resolve(value);
            } else {
              input.validationMessage = error;
            }
          }),
          input.onDidChangeValue(async text => {
            const current = Promise.resolve(params.validate(text));
            validating = current;
            const error = await current;
            if (current === validating) {
              input.validationMessage = error;
            }
          }),
          input.onDidHide(() => reject(InputFlowAction.cancel))
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }
}
