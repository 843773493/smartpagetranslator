import * as vscode from 'vscode';
import * as fs from 'fs';
import * as gl from 'glob';
import * as path from 'path';
import { Note } from './note';

export class NotesViewProvider implements vscode.TreeDataProvider<Note> {

	private _onDidChangeTreeData: vscode.EventEmitter<Note | undefined> = new vscode.EventEmitter<Note | undefined>();
	readonly onDidChangeTreeData: vscode.Event<Note | undefined> = this._onDidChangeTreeData.event;
	private folderMap: Map<string, Note[]> = new Map<string, Note[]>();

	constructor(
		private notesLocation: string,
		private notesExtensions: string) {
	};

	public init(): NotesViewProvider {
		this.refresh();
		return this;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(note: Note): vscode.TreeItem {
		return note;
	}

	getChildren(note?: Note): Thenable<Note[]> {
		if (!this.notesLocation) {
			return Promise.resolve([]);
		}

		if (note && note.isFolder) {
			return Promise.resolve(this.getNotes(note.fullPath, this.notesExtensions));
		}
		else if (note) {
			return Promise.resolve([]);
		}
		else {
			return Promise.resolve(this.getNotes(this.notesLocation, this.notesExtensions));
		}
	}

	getNotes(notesLocation: string, notesExtensions: string): Note[] {
		if (this.pathExists(notesLocation)) {
			const result: Note[] = [];

			try {
				const items = fs.readdirSync(notesLocation, { withFileTypes: true });

				for (const item of items) {
					if (item.isDirectory()) {
						const folderPath = path.join(notesLocation, item.name);
						const folderNote = new Note(
							item.name,
							notesLocation,
							'',
							'',
							true
						);
						result.push(folderNote);
					}
				}

				const listOfNotes = (note: string): Note => {
					return new Note(
						path.basename(note),
						notesLocation,
						'',
						'',
						false,
						{
							command: 'smartPageTranslator.notes.openNote',
							title: '',
							arguments: [path.join(notesLocation, note)]
						});
				};

				let notes;
				if (notesExtensions === '*') {
					notes = gl.sync('*', { cwd: notesLocation, nodir: true, nocase: true }).map(listOfNotes);
				} else {
					notes = gl.sync(`*.{${notesExtensions}}`, { cwd: notesLocation, nodir: true, nocase: true }).map(listOfNotes);
				}
				result.push(...notes);
			} catch (err) {
				console.error('Error reading directory:', err);
			}

			result.sort((a, b) => {
				if (a.isFolder && !b.isFolder) {
					return -1;
				}
				if (!a.isFolder && b.isFolder) {
					return 1;
				}
				return a.name.localeCompare(b.name);
			});

			return result;
		}
		else {
			return [];
		}
	}

	private pathExists(p: string): boolean {
		try {
			fs.accessSync(p);
		} catch (err) {
			return false;
		}
		return true;
	}

}