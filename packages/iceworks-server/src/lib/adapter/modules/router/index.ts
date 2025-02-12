import * as path from 'path';
import * as fs from 'fs';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

import formatCodeFromAST from '../../utils/formatCodeFromAST';
import { IRouter, IRouterModule, IProject, IRouterOptions } from '../../../../interface';

const ROUTER_CONFIG_VARIABLE = 'routerConfig';
const LAYOUT_DIRECTORY = 'layouts';
const PAGE_DIRECTORY = 'pages';

const ROUTE_PROP_WHITELIST = ['component', 'path', 'exact', 'strict', 'sensitive', 'children', 'redirect'];

export default class Router implements IRouterModule {
  public readonly project: IProject;
  public readonly storage: any;

  public readonly path: string;
  public existLazy: boolean;
  public configFilePath = 'config/routes.js';
  public removePaths: string[];

  constructor(params: {project: IProject; storage: any; }) {
    const { project, storage } = params;
    this.project = project;
    this.storage = storage;
    this.path = path.join(this.project.path, 'src', this.configFilePath);
  }

  private getASTByCode(code: string): any {
    return parser.parse(code, {
      allowImportExportEverywhere: true,
      sourceType: 'module',
      plugins: [
        'dynamicImport',
      ],
    });
  }

  private getRouterConfigAST(): any {
    const routerConfigString = fs.readFileSync(this.path).toString();
    const routerConfigAST = this.getASTByCode(routerConfigString);

    return routerConfigAST;
  }

  async getAll(): Promise<IRouter[]> {
    let config = [];
    const routerConfigAST = this.getRouterConfigAST();

    try {
      traverse(routerConfigAST, {
        VariableDeclarator: ({ node }) => {
          if (
            t.isIdentifier(node.id, { name: ROUTER_CONFIG_VARIABLE })
            && t.isArrayExpression(node.init)
          ) {
            config = this.parseRoute(node.init.elements);
          }
        }
      });
    } catch (error) {
      console.log(error);
    }
    return config;
  }

  parseRoute(elements) {
    const config = [];
    elements.forEach((element) => {
      // { path: '/home', component: Home, children: [] }
      const { properties } = element;
      const item: any = {};
      properties.forEach((property) => {
        const { key, value } = property;
        const { name: keyName } = key;

        // component is react Component
        if (keyName === 'component') {
          item[keyName] = value.name;
        } else if (keyName === 'children') {
          // children is array
          item.children = this.parseRoute(value.elements);
        } else if (ROUTE_PROP_WHITELIST.indexOf(keyName) > -1) {
          item[keyName] = value.value;
        }
      });
      if (Object.keys(item).length > 0) {
        config.push(item);
      }
    });

    return config;
  }

  // bulk create routers
  async bulkCreate(params: {data: IRouter[], options: IRouterOptions}): Promise<void>  {
    let { data, options = {} } = params;
    const { replacement = false, parent } = options;
    const routerConfigAST = this.getRouterConfigAST();
    const currentData = await this.getAll();

    if (!replacement) {
      if (parent) {
        const parentRouter = currentData.find((item) => {
          if (item.children && item.path === parent) {
            return true;
          }
          return false;
        });
        if (parentRouter) {
          parentRouter.children = parentRouter.children.concat(data);
          data = currentData;
        }
      } else {
        data = currentData.concat(data);
      }
    }
    this.setData(data, routerConfigAST);
  }

  async delete(params: {componentName: string}): Promise<string[]> {
    const { componentName } = params;
    const routerConfigAST = this.getRouterConfigAST();
    const data = await this.getAll();
    this.removePaths = [];

    this.setData(this.removeItemByComponent(data, componentName), routerConfigAST);
    return this.removePaths;
  }

  removeItemByComponent(data: IRouter[], componentName: string, parent?: IRouter) {
    const removeIndex = [];
    data.forEach((item, index) => {
      if (!item.children) {
        if (item.component === componentName) {
          removeIndex.unshift(index);
          if (item.path) {
            if (parent) {
              this.removePaths.push(path.join(parent.path, item.path));
            } else {
              this.removePaths.push(item.path);
            }
          }
        }
      } else {
        item.children = this.removeItemByComponent(item.children, componentName, item);
      }
    });

    removeIndex.forEach((index) => {
      data.splice(index, 1);
    });

    return data;
  }

  private setData(data: IRouter[], routerConfigAST: any) {
    const dataAST = this.getASTByCode(JSON.stringify(this.sortData(data)));
    const arrayAST = dataAST.program.body[0];

    this.changeImportDeclarations(routerConfigAST, data);
    /**
     * { path: '/a', component: 'Page' }
     *          transform to
     * { path: '/a', component: Page }
     */
    traverse(dataAST, {
      ObjectProperty({ node }) {
        if (['component'].indexOf(node.key.value) > -1) {
          node.value = t.identifier(node.value.value);
        }
      }
    });
    traverse(routerConfigAST, {
      VariableDeclarator({ node }) {
        if (
          t.isIdentifier(node.id, { name: ROUTER_CONFIG_VARIABLE })
          && t.isArrayExpression(node.init)
        ) {
          node.init = arrayAST;
        }
      },
    });
    fs.writeFileSync(
      this.path,
      formatCodeFromAST(routerConfigAST)
    );
  }

  /**
   * sort data
   * eg.
   *  [{path: '/'}, {path: '/project'}, {path: '/project/abc'}, {path: '/bbc'}]
   *  [{path: '/project/abc'}, {path: '/project'}, {path: '/bbc'}, {path: '/'}]
   */
  private sortData(data: IRouter[]): IRouter[] {
    return data.sort((beforeItem, item) => {
      if (beforeItem.children) {
        beforeItem.children = this.sortData(beforeItem.children);
      }
      if (!beforeItem.path) {
        return 1;
      }
      if (!item.path) {
        return 0;
      }
      if (beforeItem.path.indexOf(item.path) === 0) {
        return -1;
      }
      if (item.path.indexOf(beforeItem.path) === 0) {
        return 1;
      }
      return 0;
    });
  }

  /**
   * 1. constant if there is layout or component in the data and ImportDeclarations
   * 2. remove import if there is no layout or component in the data
   * 3. add import if there is no layout or component in the ImportDeclarations
   */
  private changeImportDeclarations(routerConfigAST, data) {
    // gt v3 exist config catalog
    const existConfigCatalog = this.configFilePath.indexOf('config/') === 0;
    const importDeclarations = [];
    const removeIndex = [];
    // router import page or layout have @
    let existAtSign = false;
    this.existLazy = false;

    traverse(routerConfigAST, {
      ImportDeclaration: ({ node, key }) => {
        const { source } = node;
        const match = source.value.match(/^(\.|@)\/(layouts|pages)\//);

        if (match && match[2]) {
          const { specifiers } = node;
          const { name } = specifiers[0].local;
          existAtSign = match[1] === '@';
          importDeclarations.push({
            index: key,
            name,
            type: match[2],
          });
        }
      },

      // parse eg. `const Forbidden = React.lazy(() => import('./pages/Exception/Forbidden'));`
      VariableDeclaration: ({ node, key }) => {
        const code = generate(node.declarations[0]).code;
        const matchLazyReg = /(\w+)\s=\sReact\.lazy(.+)import\(['|"]((\.|\@)\/(\w+)\/.+)['|"]\)/;
        const match = code.match(matchLazyReg);

        if (match && match.length > 5) {
          this.existLazy = true;
          existAtSign = match[4] === '@';
          importDeclarations.push({
            index: key,
            name: match[1],
            type: match[5],
          });
        }
      },
    });

    /**
     * remove import if there is no layout or component in the data
     */
    importDeclarations.forEach((importItem) => {
      const { name, type, index } = importItem;
      let needRemove = false;

      // match layout or page
      if (type) {
        let findRouter = null;

        if (type === LAYOUT_DIRECTORY) {
          // layout only first layer
          findRouter = data.find(item => item.children && item.component === name);
        } else if (type === PAGE_DIRECTORY) {
          findRouter = data.find(item => {
            let pageItem = null;

            if (!item.children && item.component === name) {
              pageItem = item;
            }

            if (item.children) {
              item.children.forEach((route) => {
                if (route.component === name) {
                  pageItem = route;
                }
              });
            }

            return pageItem;
          });
        }
        if (!findRouter) {
          needRemove = true;
        }
      }

      if (needRemove) {
        removeIndex.unshift(index);
      }
    });

    removeIndex.forEach((index) => {
      routerConfigAST.program.body.splice(index, 1);
    });

    const existImport = this.existImport;
    // add new page or layout
    function setNewComponent(type, component) {
      const componentExist = existImport(importDeclarations, component, type);

      // no component dont add import
      if (!component) {
        return false;
      }

      if (!componentExist && !newImports.find(item => item.name === component)) {
        newImports.push({
          type,
          name: component,
        });
      }
    }

    /**
     * add import if there is no layout or component in the ImportDeclarations
     */
    const newImports = [];
    data.forEach(({ component, children }) => {
      if (children) {
        setNewComponent(LAYOUT_DIRECTORY, component);
        children.forEach((route) => setNewComponent(PAGE_DIRECTORY, route.component));
      } else {
        setNewComponent(PAGE_DIRECTORY, component);
      }
    });

    /**
     * add import to ast
     *  eg.
     *     import Page1 from './pages/Page1';
     *            or
     *     const Profile = React.lazy(() => import('./pages/Profile'));
     */
    let lazyCode = '';
    let importCode = '';
    let sign = '@';
    if (!existConfigCatalog && !existAtSign) {
      sign = '.';
    }
    newImports.forEach(({name, type}) => {
      if (!this.existLazy || type === LAYOUT_DIRECTORY) {
        // layour or not exist lazy use `import Page from '@/pages/Page'`
        importCode += `import ${name} from '${sign}/${type}/${name}';\n`;
      } else {
        // use lazy `const Page = React.lazy(() => import('@/pages/Page'))`
        lazyCode += `const ${name} = React.lazy(() => import('${sign}/${type}/${name}'));\n`;
      }
    });

    // get ast from lazy or import code
    const lazyCodeAST = this.getASTByCode(lazyCode);
    const importCodeAST = this.getASTByCode(importCode);

    const lastIndex = this.findLastImportIndex(routerConfigAST);
    routerConfigAST.program.body.splice(lastIndex, 0, ...lazyCodeAST.program.body);
    routerConfigAST.program.body.splice(
      this.existLazy ? lastIndex - 1 : lastIndex,
      0,
      ...importCodeAST.program.body
    );
  }

  /**
   * exist layout or page in the ImportDeclarations
   */
  private existImport(list, name, type) {
    return list.some((item) => {
      if (name === item.name && type === item.type) {
        return true;
      }
      return false;
    });
  }

  /**
   * find last import index
   */
  private findLastImportIndex(routerConfigAST): number {
    let lastIndex = 0;
    routerConfigAST.program.body.forEach((item, index) => {
      if (item.type === 'ImportDeclaration') {
        if (this.existLazy) {
          lastIndex = index + 2;
        } else {
          lastIndex = index + 1;
        }
      }
    });
    return lastIndex;
  }
}
